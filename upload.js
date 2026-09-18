import { supabase } from './supabase-client.js';
import { MAX_ASPECT_RATIO, computeDisplaySize } from './image-config.js';
import {
  randomSpot, clampFromRects, computeContainRect, imageColumnRect,
} from './position-utils.js';
import { repositionClock, setClockVisible } from './clock.js';
import { flashMessage } from './feedback.js';
import { showRandomHint } from './notice-board.js';

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

// Wie stark "claim" (Eigentums-Anspruch) ausgeschaltet das Bild vor dem
// Veröffentlichen verschlechtert -- erst auf diesen Bruchteil verkleinert,
// dann ohne Glättung wieder hochskaliert (siehe drawDegraded). Kleiner Wert
// = deutlich sichtbare Pixelation. 0.15 statt der ursprünglichen 0.06 --
// merklich sanftere Verpixelung.
const DEGRADE_SCALE = 0.15;

// Wie viel Bildfläche der Zuschnitt-Effekt entfernt (siehe drawCropped) --
// 0.8 behält 80%, entfernt also ~20% der Fläche. Breite und Höhe werden
// dabei um denselben Faktor verkleinert (sqrt), das Seitenverhältnis bleibt
// also erhalten -- anders als beim dritten Effekt, der Verzerrung.
const CROP_KEEP_AREA_FRACTION = 0.8;

// Skalierungsfaktoren für den Verzerrung-Effekt (pickDistortFactors/
// renderCanvas) -- ein Faktor immer gestaucht (COMPRESSED-Bereich), der
// andere gestreckt (STRETCHED-Bereich), nie beide nah bei 1, damit die
// Verzerrung immer deutlich sichtbar ist.
const DISTORT_COMPRESSED_RANGE = [0.6, 0.75];
const DISTORT_STRETCHED_RANGE = [1.25, 1.4];

// Die drei gleichberechtigten Effekte, zwischen denen toggleClaim() beim
// Ausschalten von "claim" zufällig wählt.
const CLAIM_EFFECTS = ['degrade', 'crop', 'distort'];

const WATERMARK_SYMBOL = '©';
const WATERMARK_LABEL = 'pushvrp.com';

// "circulate" ausgeschaltet: Bild verschwindet 24h nach dem Push wieder aus
// der Hauptgalerie (siehe images-repo.js/fetchImages, expires_at).
const CIRCULATE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Abstand der Consent-Zeilen unter der Vorschau zueinander bzw. zum Bild.
const CONSENT_GAP = 20;
const CONSENT_LINE_HEIGHT = 24;

// Freiraum zwischen der Consent-Liste und "push" darunter (siehe
// positionSubmitBtn) -- großzügiger als CONSENT_GAP, da "push" als
// eigenständige, klar abgesetzte Aktion wirken soll, nicht wie eine
// weitere Consent-Zeile.
const PUSH_GAP = 36;

function pad(n) {
  return String(n).padStart(2, '0');
}

// heic2any wird nur bei Bedarf geladen (HEIC-Dateien vom Handy).
let heic2anyPromise = null;
function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (heic2anyPromise) return heic2anyPromise;
  heic2anyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/heic2any/dist/heic2any.min.js';
    script.onload = () => resolve(window.heic2any);
    script.onerror = () => reject(new Error('heic2any konnte nicht geladen werden'));
    document.head.appendChild(script);
  });
  return heic2anyPromise;
}

// piexifjs wird nur bei Bedarf geladen (nur, wenn beim Push tatsächlich
// Rechte-Metadaten eingebettet werden -- siehe embedRightsMetadata),
// analog zu loadHeic2Any() oben.
let piexifPromise = null;
function loadPiexif() {
  if (window.piexif) return Promise.resolve(window.piexif);
  if (piexifPromise) return piexifPromise;
  piexifPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/piexifjs/piexif.js';
    script.onload = () => resolve(window.piexif);
    script.onerror = () => reject(new Error('piexifjs konnte nicht geladen werden'));
    document.head.appendChild(script);
  });
  return piexifPromise;
}

// piexifjs arbeitet mit JPEG-Rohdaten als "Binary String" (ein Zeichen pro
// Byte), nicht mit Blob/ArrayBuffer direkt -- diese beiden Helfer
// konvertieren dahin und wieder zurück. Byte-weise Verarbeitung in
// Häppchen (chunkSize), da String.fromCharCode(...sehrGroßesArray) bei
// mehreren MB Bilddaten den Call-Stack sprengen kann.
function blobToBinaryString(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      resolve(binary);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function binaryStringToBlob(binaryString, type) {
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Schreibt statement in die Copyright- (0th-IFD) und UserComment-Felder
 * (Exif-IFD) der JPEG-EXIF-Daten. UserComment bekommt den vorgeschriebenen
 * 8-Byte-Zeichensatz-Präfix "ASCII\0\0\0" (EXIF-Spezifikation) vorangestellt
 * -- ohne den läse ein strenger EXIF-Reader das Feld ggf. falsch. Liefert
 * bei jedem Fehler (piexifjs nicht ladbar, kaputte JPEG-Struktur, ...)
 * einfach den UNVERÄNDERTEN Original-Blob zurück -- das Einbetten ist ein
 * Zusatz, kein Grund, den Push selbst zu blockieren.
 */
async function embedRightsMetadata(blob, statement) {
  try {
    const piexif = await loadPiexif();
    const jpegBinaryString = await blobToBinaryString(blob);
    const exifDict = piexif.load(jpegBinaryString);
    exifDict['0th'][piexif.ImageIFD.Copyright] = statement;
    exifDict.Exif[piexif.ExifIFD.UserComment] = `ASCII\u0000\u0000\u0000${statement}`;
    const exifBytes = piexif.dump(exifDict);
    const newJpegBinaryString = piexif.insert(exifBytes, jpegBinaryString);
    return binaryStringToBlob(newJpegBinaryString, 'image/jpeg');
  } catch (err) {
    console.error('EXIF-Metadaten konnten nicht eingebettet werden:', err);
    return blob;
  }
}

function isHeicFile(file) {
  const name = (file.name || '').toLowerCase();
  return file.type === 'image/heic' || file.type === 'image/heif'
    || name.endsWith('.heic') || name.endsWith('.heif');
}

async function normalizeImageFile(file) {
  if (!isHeicFile(file)) return file;
  const heic2any = await loadHeic2Any();
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], (file.name || 'image').replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
}

// Deutlich sichtbare Auflösungs-Verschlechterung ("claim" ausgeschaltet):
// erst stark verkleinern, dann ohne Glättung (imageSmoothingEnabled=false)
// wieder auf die Zielgröße hochskalieren -- ergibt sichtbare Pixelation,
// statt eines unscharfen Weichzeichners, und lässt sich rückgängig machen,
// ohne das geladene Quellbild selbst zu verändern (baseImg bleibt intakt).
function drawDegraded(ctx, img, width, height) {
  const smallWidth = Math.max(1, Math.round(width * DEGRADE_SCALE));
  const smallHeight = Math.max(1, Math.round(height * DEGRADE_SCALE));
  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = smallWidth;
  smallCanvas.height = smallHeight;
  smallCanvas.getContext('2d').drawImage(img, 0, 0, smallWidth, smallHeight);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(smallCanvas, 0, 0, smallWidth, smallHeight, 0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
}

// Einer von drei Effekten ("claim" ausgeschaltet, siehe toggleClaim) --
// schneidet ein zufällig positioniertes Rechteck aus dem Original heraus
// (~20% der Fläche fehlen danach) und zieht es über die volle Canvas-Größe,
// sodass der entfernte Rand unwiederbringlich weg ist. Breite und Höhe
// werden dabei um denselben Faktor verkleinert (sqrt von
// CROP_KEEP_AREA_FRACTION) -- das Seitenverhältnis bleibt bewusst erhalten,
// nur die Verzerrung (drawDistorted) ändert es.
function drawCropped(ctx, img, width, height) {
  const sourceWidth = img.naturalWidth;
  const sourceHeight = img.naturalHeight;

  const keepFrac = Math.sqrt(CROP_KEEP_AREA_FRACTION);
  const cropWidth = sourceWidth * keepFrac;
  const cropHeight = sourceHeight * keepFrac;
  const cropX = Math.random() * (sourceWidth - cropWidth);
  const cropY = Math.random() * (sourceHeight - cropHeight);

  ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, width, height);
}

// Zufällige Skalierungsfaktoren für den dritten Effekt (Verzerrung) --
// einer aus dem gestauchten, einer aus dem gestreckten Bereich, per
// Münzwurf auf Breite/Höhe verteilt. Nichts wird zugeschnitten (voller
// Bildinhalt bleibt erhalten), aber das Seitenverhältnis ändert sich
// zwangsläufig -- siehe getEffectiveNaturalSize/renderCanvas, die
// tatsächlich abweichende Ziel-Maße daraus ableiten.
function pickDistortFactors() {
  const [cMin, cMax] = DISTORT_COMPRESSED_RANGE;
  const [sMin, sMax] = DISTORT_STRETCHED_RANGE;
  const compressed = cMin + Math.random() * (cMax - cMin);
  const stretched = sMin + Math.random() * (sMax - sMin);
  return Math.random() < 0.5
    ? { widthFactor: stretched, heightFactor: compressed }
    : { widthFactor: compressed, heightFactor: stretched };
}

// Subtiles Wasserzeichen ("publish" ausgeschaltet) -- großes, zentriertes
// "©" bei 30% Deckkraft, darunter kleiner "pushvrp.com" ebenfalls bei 30%.
// Ein dezenter dunkler Schlagschatten (ctx.shadow*) hält das halbtrans-
// parente Weiß auch auf hellem Bildgrund lesbar, ohne selbst aufzufallen --
// bewusst kein mix-blend-mode-Ersatzaufwand, der Canvas-Schlagschatten
// erreicht denselben Zweck mit Bordmitteln.
function drawWatermark(ctx, width, height) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = Math.max(2, width * 0.01);

  const symbolSize = width * 0.45;
  const labelSize = width * 0.08;
  const gap = labelSize * 0.6;
  // Grobe, aber für Zentrierungszwecke ausreichende Näherung der optisch
  // wahrgenommenen Zeichenhöhe (Versalhöhe ≈ 0.8 * Schriftgröße) -- exakte
  // Textmetriken wären hier über das Ziel hinausgeschossen.
  const symbolGlyphHeight = symbolSize * 0.8;
  const labelGlyphHeight = labelSize * 0.8;
  const totalHeight = symbolGlyphHeight + gap + labelGlyphHeight;
  const startY = height / 2 - totalHeight / 2;

  ctx.font = `bold ${Math.round(symbolSize)}px Helvetica, Arial, sans-serif`;
  ctx.fillText(WATERMARK_SYMBOL, width / 2, startY + symbolGlyphHeight);

  ctx.font = `bold ${Math.round(labelSize)}px Helvetica, Arial, sans-serif`;
  ctx.fillText(WATERMARK_LABEL, width / 2, startY + symbolGlyphHeight + gap + labelGlyphHeight);

  ctx.restore();
}

export function initUpload(refs, onUploaded) {
  const {
    fileInput, overlay, preview, escBtn, submitBtn,
    consentHintEl, consentClaimEl, consentCirculateEl, consentResponsibilityEl, countdownEl,
    copyrightEl,
  } = refs;

  // Reihenfolge der Consent-Zeilen für die Positionierung (siehe
  // positionConsents/getConsentBlockBottom) -- der Hinweis steht bewusst
  // zuletzt, nach den eigentlichen Aussagen.
  const consentOrder = [consentClaimEl, consentCirculateEl, consentResponsibilityEl, consentHintEl];

  let pendingBlob = null;
  let pendingDisplaySize = null;
  let pendingNaturalSize = null;
  let currentImageRect = null;

  // Ankerrechteck des Bildes in seiner URSPRÜNGLICHEN, unverzerrten Größe --
  // einmal pro neu geladenem Bild gesetzt (startUpload) und NIE durch einen
  // Consent-Effekt (Zuschnitt/Verzerrung, siehe currentImageRect/
  // applyImageLayout) verändert. Consent-Liste, Kursiv-Hinweis und "push"
  // hängen bewusst an diesem Rechteck statt an currentImageRect, damit sie
  // unbeweglich bleiben, auch wenn sich das tatsächlich angezeigte Bild
  // (currentImageRect) durch einen Effekt im Seitenverhältnis ändert.
  let baseImageRect = null;

  // Zuletzt geladenes Quellbild + Ziel-Auflösung (nach MAX_DIMENSION-Clamp,
  // siehe startUpload) -- renderCanvas() zeichnet bei jedem Consent-Klick
  // frisch davon ab, das Original bleibt dabei unangetastet.
  let baseImg = null;
  let baseWidth = 0;
  let baseHeight = 0;

  // Einwilligungen vor dem Veröffentlichen -- "responsibility" ist bewusst
  // nicht Teil dieses Zustands, sie ist immer aktiv und nicht abschaltbar
  // (siehe consentResponsibilityEl, kein Klick-Listener dafür). "publish"
  // ist aktuell ohne zugehöriges Klick-Element (siehe index.html) und bleibt
  // dadurch dauerhaft true -- Wasserzeichen/©-Eingabe (siehe drawWatermark/
  // copyrightEl) sind entsprechend vorübergehend nie aktiv.
  let consents = { claim: true, circulate: true, publish: true };

  // Welcher der drei "claim"-Effekte (CLAIM_EFFECTS) gerade aktiv ist -- neu
  // (zufällig) ausgewürfelt bei JEDEM Ausschalten von "claim" (siehe
  // toggleClaim), nie bei einem erneuten renderCanvas()-Aufruf (sonst würde
  // z.B. "publish" an/ausschalten während "claim" bereits aus ist den
  // claim-Effekt unbeabsichtigt neu würfeln). null, solange "claim" an ist.
  let claimEffect = null;

  // Nur gesetzt, während claimEffect === 'distort' -- siehe
  // pickDistortFactors/getEffectiveNaturalSize.
  let distortFactors = null;

  let countdownTimer = null;
  let countdownEndAt = null;

  // Name hinter dem "©" (nur relevant, während "publish" ausgeschaltet ist,
  // siehe copyrightEl unten) -- bleibt innerhalb EINES Upload-Vorgangs auch
  // erhalten, wenn "publish" zwischenzeitlich wieder ein-/ausgeschaltet
  // wird, und wird erst mit einem komplett neuen Bild zurückgesetzt (siehe
  // startUpload/closeOverlay).
  let copyrightName = '';
  let isEditingCopyright = false;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) startUpload(file);
    fileInput.value = '';
  });

  // "push" fest zentriert unter der Consent-Liste (nicht mehr zufällig
  // platziert wie esc/die Uhr) -- als klar erkennbarer, fester nächster
  // Schritt nach dem Lesen/Einstellen der Consent-Optionen, mit etwas
  // Freiraum dazwischen (PUSH_GAP). Zentriert auf die BILDSCHIRMBREITE
  // (nicht die Bildbreite, siehe positionConsents) -- dieselbe
  // Zentrierungstechnik (Breite + text-align:center statt eigener
  // Breitenmessung).
  function positionSubmitBtn() {
    if (!baseImageRect) return;
    submitBtn.style.left = '0px';
    submitBtn.style.width = window.innerWidth + 'px';
    submitBtn.style.textAlign = 'center';
    submitBtn.style.top = (getConsentBlockBottom() + PUSH_GAP) + 'px';
    submitBtn.style.right = 'auto';
    submitBtn.style.bottom = 'auto';
  }

  // Sperrzone unterhalb des (unveränderlichen) Bild-Ankerrechtecks, über die
  // GESAMTE Bildschirmbreite -- dort stehen jetzt die (bildschirmweit
  // zentrierten) Consent-Zeilen und "push" (siehe positionConsents/
  // positionSubmitBtn). Frei schwebende Textelemente (esc, Uhr, Countdown)
  // dürfen dort nie landen, egal wie das Bild selbst gerade aussieht.
  function getConsentZoneRect() {
    if (!baseImageRect) return null;
    return { left: 0, right: window.innerWidth, top: baseImageRect.bottom, bottom: window.innerHeight };
  }

  // Sperrzonen für esc/die Uhr: die GESAMTE Spalte des Bildes (nicht nur
  // seine aktuelle Fläche, siehe imageColumnRect) UND die Consent-Zone
  // darunter -- beide dürfen esc/die Uhr nie überlappen.
  function getFloatingWordAvoidRects() {
    return [imageColumnRect(currentImageRect), getConsentZoneRect()].filter(Boolean);
  }

  // Sperrzonen für den Countdown: anders als esc/die Uhr darf er laut
  // Vorgabe NEBEN oder ÜBER dem Bild stehen -- gesperrt ist daher nur das
  // Bild selbst (nicht seine ganze Spalte) und die Consent-Zone darunter,
  // damit er nie mit den (jetzt bildschirmbreiten) Consent-Sätzen
  // überlappt.
  function getCountdownAvoidRects() {
    return [currentImageRect, getConsentZoneRect()].filter(Boolean);
  }

  // Letzte Menge belegter Punkte aus repositionWords() -- positionCountdown()
  // greift beim alleinigen Aufruf (startCountdown, kein neuer
  // repositionWords()-Durchlauf) darauf zurück, damit der Countdown nicht
  // ausgerechnet auf esc oder der Uhr landet.
  let lastTakenSpots = [];

  // Platziert den Countdown zufällig neu -- bei jedem Erscheinen (Klick auf
  // "circulate", siehe startCountdown) und bei jeder Fenstergrößenänderung/
  // jedem Consent-Klick, der repositionWords() durchläuft, analog zu esc/
  // der Uhr. Nie unterhalb des Bildes (getCountdownAvoidRects).
  function positionCountdown(taken = lastTakenSpots) {
    if (!currentImageRect) return null;
    const avoidRects = getCountdownAvoidRects();
    const spot = randomSpot(taken, { margin: 60, avoidRects });
    countdownEl.style.left = spot.x + 'px';
    countdownEl.style.top = spot.y + 'px';
    countdownEl.style.right = 'auto';
    clampFromRects(countdownEl, avoidRects);
    return spot;
  }

  function repositionWords() {
    // esc bekommt bei jedem neuen Push eine neue Position -- meidet dabei
    // die GESAMTE Spalte des Bildes UND die (jetzt bildschirmbreite)
    // Consent-Zone darunter (siehe getFloatingWordAvoidRects). "push"
    // selbst ist fest positioniert (positionSubmitBtn), nicht Teil dieser
    // zufälligen Platzierung.
    const taken = [];
    const avoidRects = getFloatingWordAvoidRects();

    const escSpot = randomSpot(taken, { margin: 60, avoidRects });
    taken.push(escSpot);
    escBtn.style.left = escSpot.x + 'px';
    escBtn.style.top = escSpot.y + 'px';
    escBtn.style.right = 'auto';
    // randomSpot() prüft beim Aussuchen nur den Ankerpunkt gegen avoidRects
    // und kann im Notfall (kein freier Punkt gefunden) sie sogar ganz
    // ignorieren (siehe deren eigener Kommentar) -- eine nachträgliche
    // Fein-Korrektur anhand der tatsächlichen Bounding Box ist daher nötig,
    // dieselbe wie für die Uhr (siehe repositionClock/clock.js).
    clampFromRects(escBtn, avoidRects);

    positionSubmitBtn();
    const clockSpot = repositionClock(taken, null, avoidRects);
    if (clockSpot) taken.push(clockSpot);

    if (countdownEl.style.display === 'block') {
      const countdownSpot = positionCountdown(taken);
      if (countdownSpot) taken.push(countdownSpot);
    }

    lastTakenSpots = taken;
    return taken;
  }

  // Consent-Zeilen zentriert auf die BILDSCHIRMBREITE (nicht die
  // Bildbreite) und verankert am UNVERÄNDERLICHEN baseImageRect (nicht
  // currentImageRect) -- so bleiben sie unbeweglich, auch wenn "claim"
  // einen Effekt auslöst, der das tatsächlich angezeigte Bild zuschneidet
  // oder verzerrt (siehe applyImageLayout/currentImageRect). Der Hinweis
  // ("click to de-/activate)") steht als letzte Zeile (siehe consentOrder).
  function positionConsents() {
    if (!baseImageRect) return;
    // Breite = Bildschirmbreite + text-align:center statt einer
    // Links-Ausrichtung -- zentriert jede Zeile unabhängig von ihrer eigenen
    // Länge über der Bildschirmmitte, auch mit white-space:nowrap (siehe
    // .image-info): eine längere Zeile ragt dann symmetrisch links/rechts
    // über die Mitte hinaus, statt nur nach rechts.
    consentOrder.forEach((el, i) => {
      el.style.left = '0px';
      el.style.width = window.innerWidth + 'px';
      el.style.textAlign = 'center';
      el.style.top = (baseImageRect.bottom + CONSENT_GAP + i * CONSENT_LINE_HEIGHT) + 'px';
    });
    // copyrightEl bleibt dormant (siehe consents.publish, dauerhaft true)
    // -- Position bleibt trotzdem am (unveränderlichen) baseImageRect
    // verankert statt am Countdown, da dieser jetzt frei platziert wird.
    copyrightEl.style.left = baseImageRect.left + 'px';
    copyrightEl.style.top = (baseImageRect.top - 44) + 'px';
  }

  // Untere Kante der Consent-Liste (letzte Zeile, siehe consentOrder) --
  // "push" wird direkt darunter zentriert (siehe positionSubmitBtn). Am
  // unveränderlichen baseImageRect verankert, aus demselben Grund wie
  // positionConsents.
  function getConsentBlockBottom() {
    if (!baseImageRect) return 0;
    return baseImageRect.bottom + CONSENT_GAP + consentOrder.length * CONSENT_LINE_HEIGHT;
  }

  function setConsentOpacity(el, on) {
    el.style.opacity = on ? '1' : '0.6';
  }

  // Die tatsächlichen Ziel-Maße des Bildes -- normalerweise baseWidth/
  // baseHeight unverändert, außer während des Verzerrung-Effekts (siehe
  // pickDistortFactors/toggleClaim), der die Maße bewusst ändert.
  function getEffectiveNaturalSize() {
    if (!consents.claim && claimEffect === 'distort' && distortFactors) {
      return {
        width: Math.max(1, Math.round(baseWidth * distortFactors.widthFactor)),
        height: Math.max(1, Math.round(baseHeight * distortFactors.heightFactor)),
      };
    }
    return { width: baseWidth, height: baseHeight };
  }

  // Aktualisiert Vorschau-Größe/-Position und alle davon abhängigen
  // Textelemente auf Basis der aktuellen effektiven Maße -- nötig, weil der
  // Verzerrung-Effekt (anders als Verpixelung/Zuschnitt) die tatsächlichen
  // Bild-Maße ändert, nicht nur seinen Inhalt. Aktualisiert dabei auch
  // pendingNaturalSize/pendingDisplaySize, damit submitUpload() beim
  // tatsächlichen Push dieselben (evtl. verzerrten) Maße speichert, die
  // gerade zu sehen sind.
  function applyImageLayout() {
    const effective = getEffectiveNaturalSize();
    pendingNaturalSize = effective;
    pendingDisplaySize = computeDisplaySize(effective.width, effective.height);

    currentImageRect = computeContainRect(effective.width, effective.height);
    preview.style.width = currentImageRect.width + 'px';
    preview.style.height = currentImageRect.height + 'px';
    preview.style.left = currentImageRect.left + 'px';
    preview.style.top = currentImageRect.top + 'px';
    preview.style.transform = 'none';

    repositionWords();
    positionConsents();
  }

  function updateCopyrightDisplay() {
    if (isEditingCopyright) return;
    copyrightEl.textContent = copyrightName ? `©${copyrightName}` : '©';
  }

  function updateCopyrightVisibility() {
    copyrightEl.style.display = consents.publish ? 'none' : 'block';
  }

  // Erster Klick auf "©" macht es editierbar -- ein zweiter Klick während
  // des Editierens (z.B. um den Cursor neu zu setzen) darf das nicht
  // erneut anstoßen, siehe die Sperre oben.
  function startEditingCopyright() {
    if (isEditingCopyright) return;
    isEditingCopyright = true;
    copyrightEl.contentEditable = 'true';
    copyrightEl.style.cursor = 'text';
    copyrightEl.style.userSelect = 'text';
    copyrightEl.focus();
    const range = document.createRange();
    range.selectNodeContents(copyrightEl);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // blur/Enter beenden das Editieren und übernehmen den eingegebenen Namen
  // -- alles nach dem ersten "©" im (evtl. frei editierten) Text, führende
  // Leerzeichen entfernt.
  function stopEditingCopyright() {
    if (!isEditingCopyright) return;
    isEditingCopyright = false;
    copyrightEl.contentEditable = 'false';
    copyrightEl.style.cursor = 'pointer';
    copyrightEl.style.userSelect = 'none';
    copyrightName = (copyrightEl.textContent || '').replace(/^©\s*/, '').trim();
    updateCopyrightDisplay();
  }

  // Unbedingter Reset (anders als stopEditingCopyright, das nur beim
  // Verlassen eines AKTIVEN Edit-Zustands greift) -- für einen komplett
  // neuen Upload-Vorgang (neues Bild, siehe startUpload/closeOverlay).
  function resetCopyright() {
    copyrightName = '';
    isEditingCopyright = false;
    copyrightEl.contentEditable = 'false';
    copyrightEl.style.cursor = 'pointer';
    copyrightEl.style.userSelect = 'none';
    updateCopyrightDisplay();
    updateCopyrightVisibility();
  }

  copyrightEl.addEventListener('click', startEditingCopyright);
  copyrightEl.addEventListener('blur', stopEditingCopyright);
  copyrightEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // Verhindert, dass dasselbe [Enter] zusätzlich den globalen
    // Push-Listener weiter unten auslöst, während gerade der Name
    // eingegeben wird.
    e.stopPropagation();
    // Direkt aufrufen statt nur über blur() -- ein rein programmatischer
    // blur()-Aufruf löst nicht in jeder Umgebung zuverlässig das
    // 'blur'-Event aus, das den Editier-Zustand sonst beenden würde. Der
    // zusätzliche blur()-Aufruf danach entfernt bestenfalls noch den
    // Eingabe-Fokus selbst.
    stopEditingCopyright();
    copyrightEl.blur();
  });

  // Zeichnet die Vorschau (und damit den späteren Upload-Blob) frisch aus
  // baseImg -- mit "claim" ausgeschaltet pixelig verschlechtert, mit
  // "publish" ausgeschaltet zusätzlich mit Wasserzeichen versehen. Beides
  // kann gleichzeitig aktiv sein. pendingBlob wird dabei live mit
  // aktualisiert, nicht erst beim Klick auf "push" -- was man in der
  // Vorschau sieht, ist exakt das, was hochgeladen würde.
  function renderCanvas() {
    if (!baseImg) return;
    // width/height hier NICHT baseWidth/baseHeight direkt -- beim
    // Verzerrung-Effekt liefert getEffectiveNaturalSize() bewusst andere
    // Maße (siehe dort), das Canvas muss also in dieser Zielgröße gezeichnet
    // werden, nicht in der Originalgröße.
    const { width, height } = getEffectiveNaturalSize();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (claimEffect === 'crop') {
      drawCropped(ctx, baseImg, width, height);
    } else if (!consents.claim && claimEffect === 'degrade') {
      drawDegraded(ctx, baseImg, width, height);
    } else {
      // "claim" an (kein Effekt) ODER Verzerrung: in beiden Fällen einfach
      // das volle Bild zeichnen -- bei Verzerrung sorgen allein die (dann
      // abweichenden) width/height für den Effekt, kein separater Zuschnitt.
      ctx.drawImage(baseImg, 0, 0, width, height);
    }
    if (!consents.publish) {
      drawWatermark(ctx, width, height);
    }

    preview.src = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    canvas.toBlob((blob) => {
      pendingBlob = blob;
    }, 'image/jpeg', JPEG_QUALITY);
  }

  function updateCountdownText() {
    const remaining = Math.max(0, countdownEndAt - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    countdownEl.textContent = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  // Läuft ab dem Klick auf "circulate" (nicht erst ab dem tatsächlichen
  // Push) -- reine Vorschau im Upload-Fenster, damit man den Effekt sofort
  // sieht. Die tatsächliche, dauerhafte Ablauffrist (expires_at) wird beim
  // Push selbst neu ab DANN gesetzt (siehe submitUpload) -- unabhängig
  // davon, wie lange dieser Countdown hier schon lief.
  function startCountdown() {
    countdownEndAt = Date.now() + CIRCULATE_WINDOW_MS;
    countdownEl.style.display = 'block';
    updateCountdownText();
    // Neue Zufallsposition bei jedem Erscheinen (wie esc/die Uhr) -- erst
    // NACH dem Sichtbarmachen, da positionCountdown/clampFromRects mit der
    // tatsächlich gerenderten Bounding Box arbeitet.
    positionCountdown();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdownText, 1000);
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEndAt = null;
    countdownEl.style.display = 'none';
  }

  function toggleClaim() {
    consents.claim = !consents.claim;
    setConsentOpacity(consentClaimEl, consents.claim);
    // Neu gewürfelt bei JEDEM Ausschalten (nicht nur beim ersten) -- erneutes
    // An- und wieder Ausschalten soll laut Vorgabe jedes Mal neu zufällig
    // zwischen den drei Effekten wählen.
    if (consents.claim) {
      claimEffect = null;
      distortFactors = null;
    } else {
      claimEffect = CLAIM_EFFECTS[Math.floor(Math.random() * CLAIM_EFFECTS.length)];
      distortFactors = claimEffect === 'distort' ? pickDistortFactors() : null;
    }
    // Reihenfolge wichtig: applyImageLayout() braucht getEffectiveNaturalSize(),
    // die wiederum den gerade oben gesetzten claimEffect/distortFactors
    // liest -- muss also vor renderCanvas() (das dieselbe Größe fürs Canvas
    // braucht) UND nach dem Setzen von claimEffect laufen.
    applyImageLayout();
    renderCanvas();
  }

  function toggleCirculate() {
    consents.circulate = !consents.circulate;
    setConsentOpacity(consentCirculateEl, consents.circulate);
    if (consents.circulate) {
      stopCountdown();
    } else {
      startCountdown();
    }
  }

  consentClaimEl.addEventListener('click', toggleClaim);
  consentCirculateEl.addEventListener('click', toggleCirculate);

  async function startUpload(file) {
    try {
      file = await normalizeImageFile(file);
    } catch (err) {
      console.error('HEIC-Konvertierung fehlgeschlagen:', err);
      flashMessage('error: could not read this image');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => {
        flashMessage('error: unsupported image format');
      };
      img.onload = () => {
        // naturalWidth/naturalHeight statt width/height: Letztere spiegeln
        // bei einem nie ins DOM eingefügten Image() nicht zuverlässig die
        // tatsächliche Pixelgröße wider -- vereinzelt (v.a. beim allerersten
        // Bild nach einem frischen Seitenaufbau) lasen sie hier 0, obwohl
        // onload bereits gefeuert hatte, und ließen die Vorschau als 0x0-
        // Element verschwinden. naturalWidth/naturalHeight sind laut
        // Spezifikation ab onload garantiert die echten Maße.
        const ratio = Math.max(img.naturalWidth, img.naturalHeight)
          / Math.min(img.naturalWidth, img.naturalHeight);
        if (ratio > MAX_ASPECT_RATIO) {
          flashMessage(`error: aspect ratio too extreme (max 1:${MAX_ASPECT_RATIO})`);
          return;
        }

        let width = img.naturalWidth;
        let height = img.naturalHeight;
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
          width *= scale;
          height *= scale;
        }

        baseImg = img;
        baseWidth = Math.round(width);
        baseHeight = Math.round(height);
        // Einmal pro neuem Bild berechnet, danach nie mehr verändert (siehe
        // Kommentar bei der Deklaration) -- unabhängig von etwaigen
        // Zuschnitt-/Verzerrung-Effekten, die weiter unten nur
        // currentImageRect (das tatsächlich sichtbare Bild) ändern.
        baseImageRect = computeContainRect(baseWidth, baseHeight);

        // Neues Bild -- Einwilligungen (und ihre Effekte) starten frisch bei
        // "alles an", unabhängig vom Zustand eines vorherigen Uploads (auch
        // ein Drop auf ein bereits offenes Fenster ersetzt so sauber alles).
        consents = { claim: true, circulate: true, publish: true };
        claimEffect = null;
        distortFactors = null;
        [consentClaimEl, consentCirculateEl].forEach((el) => setConsentOpacity(el, true));
        stopCountdown();
        resetCopyright();

        // Bildfläche berechnet statt gemessen — sofort korrekt, unabhängig
        // vom Ladezustand des Vorschaubilds. Setzt dabei auch
        // pendingNaturalSize/pendingDisplaySize (siehe dort).
        applyImageLayout();
        renderCanvas();

        overlay.style.display = 'block';
        // Die globale Uhr (Datum/Uhrzeit) wird im Upload-Fenster bewusst
        // nicht gezeigt -- anders als die Schaltzeituhr (countdownEl), die
        // eine eigene, unabhängige Anzeige ist und davon unberührt bleibt.
        setClockVisible(false);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function closeOverlay() {
    overlay.style.display = 'none';
    setClockVisible(true);
    pendingBlob = null;
    pendingDisplaySize = null;
    pendingNaturalSize = null;
    currentImageRect = null;
    baseImageRect = null;
    baseImg = null;
    baseWidth = 0;
    baseHeight = 0;
    consents = { claim: true, circulate: true, publish: true };
    claimEffect = null;
    distortFactors = null;
    [consentClaimEl, consentCirculateEl].forEach((el) => setConsentOpacity(el, true));
    stopCountdown();
    resetCopyright();
  }

  escBtn.addEventListener('click', closeOverlay);

  let isUploading = false;

  async function submitUpload() {
    if (!pendingBlob || isUploading) return;

    isUploading = true;
    submitBtn.style.pointerEvents = 'none';
    submitBtn.style.opacity = '0.3';

    try {
      // Rechte-Statement als EXIF-Metadaten einbetten (Copyright/UserComment,
      // siehe embedRightsMetadata) -- nur hier beim tatsächlichen Push,
      // nicht bei jedem Consent-Klick wie Pixelation/Wasserzeichen (die
      // sofortige Vorschau in renderCanvas braucht das nicht). Schlägt das
      // Einbetten fehl, liefert embedRightsMetadata einfach pendingBlob
      // unverändert zurück -- der Push wird dadurch nie blockiert.
      const rightsStatement = consents.publish
        ? 'Free to use. Downloaded from pushvrp.com'
        : `©${copyrightName || 'unknown'}. All rights reserved. Downloaded from pushvrp.com`;
      const uploadBlob = await embedRightsMetadata(pendingBlob, rightsStatement);

      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      const path = `uploads/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('images')
        .upload(path, uploadBlob, { contentType: 'image/jpeg' });

      if (uploadError) {
        console.error('Upload fehlgeschlagen:', uploadError);
        flashMessage('error: upload failed');
        return;
      }

      const { data: publicData } = supabase.storage.from('images').getPublicUrl(path);

      // expires_at ab JETZT (Push-Zeitpunkt), unabhängig davon, wie lange
      // der Countdown im Upload-Fenster schon sichtbar lief (siehe
      // startCountdown) -- einfacher und robuster als eine Frist ab dem
      // Klick auf "circulate" serverseitig nachzuvollziehen.
      const expiresAt = consents.circulate ? null : new Date(Date.now() + CIRCULATE_WINDOW_MS).toISOString();

      const { data: inserted, error: insertError } = await supabase
        .from('images')
        .insert({
          url: publicData.publicUrl,
          natural_width: pendingNaturalSize.width,
          natural_height: pendingNaturalSize.height,
          expires_at: expiresAt,
        })
        .select()
        .single();

      if (insertError) {
        console.error('Datenbankeintrag fehlgeschlagen:', insertError);
        flashMessage('error: could not save image');
        return;
      }

      const displaySize = pendingDisplaySize;
      closeOverlay();
      showRandomHint();

      onUploaded({
        id: inserted.id,
        url: inserted.url,
        width: displaySize.width,
        height: displaySize.height,
      });
    } finally {
      isUploading = false;
      submitBtn.style.pointerEvents = 'auto';
      submitBtn.style.opacity = '1';
    }
  }

  submitBtn.addEventListener('click', submitUpload);

  // [Enter] löst dieselbe Bestätigung aus wie der Klick auf "push" -- nur
  // während das Upload-Fenster offen ist.
  document.addEventListener('keydown', (e) => {
    if (overlay.style.display !== 'block' || e.key !== 'Enter') return;
    e.preventDefault();
    submitUpload();
  });

  return {
    handleFile: startUpload,
    // Für Fenstergrößenänderungen: nur die frei positionierten Textelemente
    // zurück in den sichtbaren Bereich holen — das Vorschaubild behält
    // seine ursprüngliche Größe.
    reposition: () => {
      if (overlay.style.display === 'block') {
        repositionWords();
        positionConsents();
      }
    },
  };
}

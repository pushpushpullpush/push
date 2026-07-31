import { supabase } from './supabase-client.js';
import { fetchImageById } from './images-repo.js';
import { fetchPullersForImage } from './profile-data.js';
import { randomSpot, clampToViewport, clampFromRect, computeContainRect } from './position-utils.js';
import { createHeightmap, placeImage } from './layout-engine.js';
import { repositionClock, setClockVisible } from './clock.js';
import { repositionShootWord, setShootWordVisible } from './shoot.js';
import { flashMessage } from './feedback.js';
import { showMessage, showRandomHint } from './notice-board.js';
import { flyIntoCollection, getImageCornerRect } from './pull-animation.js';
import { pushRoute, replaceRoute, goBack, imagePath } from './router.js';
import { MAX_ASPECT_RATIO } from './image-config.js';

const CHAR_LIMIT = 37;

// Sicherheitsabstand der frei platzierten Textelemente zur Bildfläche
// bzw. zum Bildschirmrand — großzügiger als der allgemeine Default,
// damit in der Einzelansicht nichts ins Bild hineinragt.
const IMAGE_SAFETY_PAD = 40;
const EDGE_SAFETY_PAD = 32;

// "reproduce": zwei unabhängige Zufallsbereiche für den "Grad des Eingriffs"
// (keine Regler für den Nutzer) — bei jeder Reproduktion neu gewürfelt.
const FRAGMENT_AREA_MIN = 0.85; // Zuschnitt behält 85–95% der Originalfläche
const FRAGMENT_AREA_MAX = 0.95;
const RESOLUTION_SCALE_MIN = 0.03; // Auflösungspfad skaliert auf 3–8% der Dimensionen
const RESOLUTION_SCALE_MAX = 0.08; // deutlich aggressiver als der Zuschnitt, beabsichtigt
// Deutlich unter dem normalen Upload-Wert (0.82, siehe upload.js) — nur für
// den Auflösungspfad, der Fragment-Pfad degradiert allein durch den Ausschnitt.
const REPRODUCE_JPEG_QUALITY = 0.35;
// Ab dieser Generation wird "reproduce" nicht mehr angeboten (die 8. Generation
// entstünde sonst) — analog zur Sichtbarkeitslogik von "trace".
const MAX_REPRODUCE_GENERATION = 7;

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Cross-Origin-Bilder (Supabase Storage) dürfen nicht direkt vom <img>-Element
 * gezeichnet werden — das markiert den Canvas als "tainted", toBlob()/
 * getImageData() schlagen dann fehl. Stattdessen als Blob laden und daraus
 * ein Offscreen-<img> bauen, von dem gefahrlos gezeichnet werden kann.
 */
async function loadImageForCanvas(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Zufälliges Ausschnitt-Rechteck für den Fragment-Pfad: Zielfläche zufällig
 * zwischen FRAGMENT_AREA_MIN/MAX der Originalfläche, Ziel-Seitenverhältnis
 * UNABHÄNGIG vom Original zufällig gewählt (Orientierungswechsel möglich —
 * aus Hochformat kann Querformat werden), innerhalb MAX_ASPECT_RATIO. Die
 * Zielfläche hat Vorrang vor dem exakten Wunsch-Seitenverhältnis: passt das
 * ideale Rechteck nicht ins Original (bei sehr länglichen Originalen manchmal
 * unvermeidbar), wird stattdessen das größtmögliche Rechteck mit demselben
 * Seitenverhältnis gewählt, das noch ins Original passt (statt eines
 * ungültigen, zu großen Zuschnitts).
 */
function computeFragmentRect(width, height) {
  const areaFraction = randomInRange(FRAGMENT_AREA_MIN, FRAGMENT_AREA_MAX);
  const targetArea = width * height * areaFraction;

  const longShortRatio = 1 + Math.random() * (MAX_ASPECT_RATIO - 1);
  const targetRatio = Math.random() < 0.5 ? longShortRatio : 1 / longShortRatio;

  let fragW = Math.sqrt(targetArea * targetRatio);
  let fragH = targetArea / fragW;

  if (fragW > width || fragH > height) {
    // Passt nicht ins Original — größtmögliches Rechteck mit targetRatio
    // nehmen (klassisches "contain"-Fitting), statt die Zielfläche stur
    // durchzusetzen.
    if (targetRatio >= width / height) {
      fragW = width;
      fragH = width / targetRatio;
    } else {
      fragH = height;
      fragW = height * targetRatio;
    }
  }

  const x = Math.random() * Math.max(0, width - fragW);
  const y = Math.random() * Math.max(0, height - fragH);
  return { x, y, width: fragW, height: fragH };
}

/**
 * Erzeugt aus dem Ausgangsbild per Zufall (50/50, dem Nutzer nicht angezeigt)
 * entweder eine Auflösungs-/Qualitätsreduktion oder ein Fragment. Der Grad
 * des Eingriffs wird pro Reproduktion neu innerhalb der jeweiligen
 * Zufallsbereiche gewürfelt (siehe Konstanten oben).
 */
async function createReproduction(sourceUrl) {
  const img = await loadImageForCanvas(sourceUrl);
  const useFragment = Math.random() < 0.5;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (useFragment) {
    const rect = computeFragmentRect(img.naturalWidth, img.naturalHeight);
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  } else {
    const scale = randomInRange(RESOLUTION_SCALE_MIN, RESOLUTION_SCALE_MAX);
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  const quality = useFragment ? undefined : REPRODUCE_JPEG_QUALITY;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return { blob, width: canvas.width, height: canvas.height };
}

// Bilder in der Galerie sind loading="lazy" — ein per [z] gezeigtes Bild
// hat daher oft noch gar nicht angefangen zu laden. Ohne das hier würde das
// sichtbare <img> sofort auf die neue Größe/URL umgestellt, während die
// Bilddaten noch unterwegs sind — kurz sichtbar als "springt auf kleiner,
// bevor das neue Bild da ist". Erst wenn das neue Bild fertig geladen ist,
// wird sichtbar umgeschaltet — bis dahin bleibt einfach das alte Bild in
// Ruhe stehen. Bewusst onload/onerror statt img.decode(): decode() kann für
// (hier: cross-origin gehostete) Bilder bzw. in Hintergrund-Tabs in manchen
// Browsern hängen bleiben, ohne je aufzulösen — Sicherheits-Timeout, damit
// die Ansicht so oder so nie länger als kurz blockiert bleibt.
const PRELOAD_TIMEOUT_MS = 2000;

function preloadImage(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const probe = new Image();
    probe.onload = finish;
    probe.onerror = finish;
    probe.src = url;
    setTimeout(finish, PRELOAD_TIMEOUT_MS);
  });
}

export function initSingleView(
  refs, getImages, getCurrentUser, onNeedsLogin, onPullToggled, onOpenProfile, onReproduce, onOpenTrace,
) {
  const {
    overlay, imageEl, escBtn, zBtn, pullBtn, commentBtn, reportBtn, viewsEl,
    reproduceBtn, traceBtn,
    commentsLayer, dimEsc, typeInput, submitBtn, thanksEl,
  } = refs;

  let currentImage = null;
  let currentImageRect = null;
  let currentContextImages = null; // welche Liste "z" gerade durchsucht
  let isPulled = false;
  let mode = 'view'; // 'view' | 'comment' | 'report'
  let commentsHeightmap = createHeightmap();
  const COMMENT_CHIP_HEIGHT = 32;
  let viewsChannel = null;

  // true, wenn die aktuell offene Ansicht über trace.js (bzw. allgemein
  // "still", ohne eigenen Schritt im Browser-Verlauf) geöffnet wurde — dann
  // löst escBtn kein goBack() aus, sondern legt nur die darunterliegende
  // trace-Ansicht wieder frei (siehe escBtn-Handler unten).
  let wasSilentOpen = false;

  // false nur für Einzelbilder, die aus trace.js heraus geöffnet wurden:
  // dort kein weiteres [z]-Browsen und kein "trace" (sonst Endlosschleife
  // trace -> single view -> trace -> ...), siehe open()/showRandom() unten.
  let currentBrowsable = true;

  // Erhöht sich bei jedem open()/close() — eine open()-Anfrage, die während
  // des Preloads (siehe preloadImage oben) durch eine neuere Anfrage oder
  // ein zwischenzeitliches close() überholt wurde, erkennt das daran und
  // wendet ihr (dann veraltetes) Ergebnis nicht mehr an.
  let openGeneration = 0;

  // Globaler Klick-Zähler: erhöht sich atomar serverseitig bei jedem
  // Öffnen der Einzelansicht, Live-Update per Realtime, falls parallel
  // jemand anderes dasselbe Bild ansieht.
  function unsubscribeViews() {
    if (viewsChannel) {
      supabase.removeChannel(viewsChannel);
      viewsChannel = null;
    }
  }

  async function trackView(imageId) {
    unsubscribeViews();

    const { data, error } = await supabase.rpc('increment_image_views', { p_image_id: imageId });
    if (error) {
      console.error('View-Zähler fehlgeschlagen:', error);
    } else if (typeof data === 'number') {
      viewsEl.textContent = `views: ${data}`;
      // Der Text kommt erst asynchron nach dem Positionieren an und kann
      // dadurch breiter werden als angenommen — noch einmal korrigieren.
      correctElementForImage(viewsEl);
    }

    viewsChannel = supabase
      .channel(`image-views-${imageId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'images', filter: `id=eq.${imageId}`,
      }, (payload) => {
        if (typeof payload.new.views === 'number') {
          viewsEl.textContent = `views: ${payload.new.views}`;
          correctElementForImage(viewsEl);
        }
      })
      .subscribe();
  }

  function resetCommentsStage() {
    commentsLayer.innerHTML = '';
    commentsHeightmap = createHeightmap();
    // Bühne beginnt exakt unterhalb des Bildes — beim ersten Laden ist
    // dadurch garantiert nichts vom Bild verdeckt.
    commentsLayer.style.marginTop = (currentImageRect.bottom + 30) + 'px';
    commentsLayer.style.minHeight = '0px';
  }

  function updateCommentsStageHeight() {
    const tallest = Math.max(...commentsHeightmap);
    commentsLayer.style.minHeight = (tallest + 40) + 'px';
  }

  function placeChip(el, width) {
    const stageWidth = commentsLayer.clientWidth || window.innerWidth;
    const pos = placeImage({ width, height: COMMENT_CHIP_HEIGHT }, commentsHeightmap, stageWidth);
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    updateCommentsStageHeight();
  }

  async function loadComments(imageId) {
    const { data, error } = await supabase
      .from('comments')
      .select('id, body, user_id')
      .eq('image_id', imageId)
      .eq('report_hidden', false)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('Kommentare laden fehlgeschlagen:', error);
      flashMessage('error: could not load notes');
      return;
    }
    (data || []).reverse().forEach((c) => addCommentToLayer(c));
  }

  function showDeleteConfirm(el, comment) {
    const originalText = el.textContent;

    el.innerHTML = '';
    el.style.cursor = 'default';

    const deleteWord = document.createElement('span');
    deleteWord.textContent = 'delete';
    deleteWord.style.cursor = 'pointer';
    deleteWord.style.marginRight = '10px';

    const escWord = document.createElement('span');
    escWord.textContent = 'b';
    escWord.style.cursor = 'pointer';

    el.appendChild(deleteWord);
    el.appendChild(escWord);

    escWord.addEventListener('click', (e) => {
      e.stopPropagation();
      el.innerHTML = '';
      el.textContent = originalText;
      el.style.cursor = 'pointer';
    });

    deleteWord.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { error } = await supabase.from('comments').delete().eq('id', comment.id);
      if (error) {
        console.error('Kommentar löschen fehlgeschlagen:', error);
        flashMessage('error: could not delete');
        return;
      }
      el.remove();
    });
  }

  function addCommentToLayer(comment) {
    const el = document.createElement('div');
    el.className = 'tag-chip'; // gleiche gelb-kursive Optik wie die Tags
    el.style.position = 'absolute';
    el.textContent = comment.body;
    commentsLayer.appendChild(el);
    placeChip(el, Math.max(90, comment.body.length * 8 + 20));

    const user = getCurrentUser();
    const isMine = user && comment.user_id === user.id;
    if (isMine) {
      el.style.cursor = 'pointer';
      el.style.pointerEvents = 'auto'; // Container hat pointer-events:none, hier gezielt aufheben
      el.addEventListener('click', () => showDeleteConfirm(el, comment));
    }
  }

  function addPullerChip(username) {
    const el = document.createElement('div');
    el.className = 'username-color';
    el.style.position = 'absolute';
    el.style.fontSize = '16px';
    el.style.cursor = 'pointer';
    el.style.pointerEvents = 'auto'; // Container hat pointer-events:none
    el.textContent = username;
    el.addEventListener('click', () => {
      close();
      onOpenProfile && onOpenProfile(username);
    });
    commentsLayer.appendChild(el);
    placeChip(el, Math.max(90, username.length * 9 + 20));
  }

  async function loadPullers(imageId) {
    const pullers = await fetchPullersForImage(imageId);
    pullers.forEach((username) => addPullerChip(username));
  }

  let actionWordSpots = [];

  // Schiebt ein bereits positioniertes Element notfalls vom aktuellen Bild
  // weg — ohne es komplett neu zu würfeln. Genutzt, wenn die Position
  // eigentlich gehalten werden soll (z.B. beim Bildwechsel per [z], oder
  // wenn der views-Text erst nachträglich breiter wird als angenommen).
  function correctElementForImage(el) {
    const reportRect = reportBtn.getBoundingClientRect();
    clampFromRect(el, currentImageRect, IMAGE_SAFETY_PAD);
    clampFromRect(el, reportRect, 20);
    clampToViewport(el, EDGE_SAFETY_PAD);
  }

  function correctPositionsForImage() {
    [escBtn, zBtn, pullBtn, commentBtn, reproduceBtn, traceBtn, viewsEl].forEach(correctElementForImage);
    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
    const shootEl = document.getElementById('shoot-word');
    if (shootEl) correctElementForImage(shootEl);
  }

  function positionActionWords() {
    const taken = [];

    // reportBtn ist fest unten rechts verankert (siehe CSS) und wird hier
    // nicht mehr zufällig platziert — andere Textelemente weichen ihm
    // trotzdem weiterhin aus, damit nichts überlappt.
    const reportRect = reportBtn.getBoundingClientRect();
    taken.push({ x: reportRect.left, y: reportRect.top });

    [escBtn, zBtn, pullBtn, commentBtn, reproduceBtn, traceBtn, viewsEl].forEach((el) => {
      const spot = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      correctElementForImage(el);
    });
    actionWordSpots = taken;
    repositionClock(taken, currentImageRect);
    repositionShootWord(taken, currentImageRect);

    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
    const shootEl = document.getElementById('shoot-word');
    if (shootEl) correctElementForImage(shootEl);
  }

  // "drop" (schon gesammelt) erscheint kleiner, in Uhrzeit-Schriftgröße —
  // "collect" (noch nicht gesammelt) bleibt normal groß.
  function updatePullButtonStyle() {
    pullBtn.textContent = isPulled ? 'drop' : 'collect';
    pullBtn.style.fontSize = isPulled ? '16px' : '';
  }

  async function refreshPullState() {
    const user = getCurrentUser();
    if (!user || !currentImage) {
      isPulled = false;
      updatePullButtonStyle();
      return;
    }
    const { data } = await supabase
      .from('pulls')
      .select('id')
      .eq('user_id', user.id)
      .eq('image_id', currentImage.id)
      .maybeSingle();
    isPulled = !!data;
    updatePullButtonStyle();
  }

  // "trace" ist sichtbar, sobald das aktuelle Bild Teil einer Reproduktions-
  // Familie ist (Original oder Reproduktion — beide haben ein gesetztes
  // family_root_id, siehe upload.js) UND diese Ansicht browsable ist — aus
  // trace.js selbst geöffnete Bilder zeigen "trace" nie (sonst Endlosschleife).
  function updateTraceVisibility() {
    const hasFamily = !!(currentImage && currentImage.familyRootId);
    traceBtn.style.display = hasFamily && currentBrowsable ? 'block' : 'none';
  }

  // "reproduce" ist ab MAX_REPRODUCE_GENERATION nicht mehr verfügbar — eine
  // weitere Reproduktion würde die (nicht erlaubte) nächste Generation erzeugen.
  function updateReproduceVisibility() {
    const generation = currentImage ? (currentImage.generation || 0) : 0;
    reproduceBtn.style.display = generation >= MAX_REPRODUCE_GENERATION ? 'none' : 'block';
  }

  async function open(imageId, imagesList, opts = {}) {
    const { silent = false, browsable = true } = opts;
    if (imagesList) currentContextImages = imagesList;
    const images = currentContextImages || getImages();
    let img = images.find((i) => i.id === imageId);
    if (!img) {
      // Nicht in einer bereits geladenen Galerie-Liste (z.B. Direktaufruf
      // eines geteilten Links auf ein älteres Bild) — einzeln nachladen.
      img = await fetchImageById(imageId);
      if (!img) return;
    }

    const myGeneration = ++openGeneration;
    // Galerie-Bilder sind loading="lazy" — bei [z] auf ein Bild, das noch nie
    // im Sichtbereich war, hat der Browser die Daten oft noch gar nicht
    // geladen. Ohne dieses Warten würde die Größe/URL des <img> sofort
    // umgestellt, während die Bilddaten noch unterwegs sind — sichtbar als
    // kurzes "springt auf falsche Größe, bevor das Bild da ist". Bis das neue
    // Bild bereitsteht, bleibt einfach das alte unverändert stehen.
    await preloadImage(img.url);
    if (myGeneration !== openGeneration) return; // zwischenzeitlich überholt (neueres [z] oder geschlossen)

    // Nur ein frischer Einstieg aus der Galerie bekommt eine neue zufällige
    // Anordnung der Textelemente — solange man (z.B. über mehrfaches [z])
    // in der Einzelansicht bleibt, halten sie ihre Position.
    const wasAlreadyOpen = overlay.style.display === 'block';

    currentImage = img;
    currentImageRect = computeContainRect(img.width, img.height);

    imageEl.src = img.url;
    imageEl.style.width = currentImageRect.width + 'px';
    imageEl.style.height = currentImageRect.height + 'px';
    imageEl.style.left = currentImageRect.left + 'px';
    imageEl.style.top = currentImageRect.top + 'px';
    imageEl.style.transform = 'none';

    overlay.style.display = 'block';
    overlay.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    setClockVisible(true);
    currentBrowsable = browsable;
    zBtn.style.display = browsable ? 'block' : 'none';
    updateTraceVisibility();
    updateReproduceVisibility();
    wasSilentOpen = silent;
    // Nur der frische Einstieg in die Einzelansicht ist ein eigener Schritt
    // im Browser-Verlauf — Bildwechsel währenddessen (z.B. mehrfaches [z])
    // aktualisieren nur die URL (Reload/Teilen-Link), ohne eigenen Eintrag,
    // damit [b] direkt zur übergeordneten Seite zurückführt. "silent" (aus
    // trace.js): gar keine History-Interaktion — dort läuft die Navigation
    // komplett lokal (siehe escBtn-Handler und trace.js).
    if (!silent) {
      if (wasAlreadyOpen) {
        replaceRoute(imagePath(img.id), `push v.r.p. — image ${img.id}`);
      } else {
        pushRoute(imagePath(img.id), `push v.r.p. — image ${img.id}`);
      }
    }
    if (!wasAlreadyOpen) {
      positionActionWords();
    } else {
      // Position halten (siehe [z]-Verhalten), aber vor Überlappung mit dem
      // neuen — möglicherweise anders geformten — Bild schützen.
      correctPositionsForImage();
    }
    resetCommentsStage();
    await refreshPullState();
    await loadComments(img.id);
    await loadPullers(img.id);
    trackView(img.id);
  }

  function close() {
    openGeneration += 1; // verwirft eine evtl. noch wartende open()-Anfrage (siehe preloadImage oben)
    overlay.style.display = 'none';
    unsubscribeViews();
    currentImage = null;
    currentImageRect = null;
    currentContextImages = null;
    mode = 'view';
    wasSilentOpen = false;
    currentBrowsable = true;

    const ownOpen = document.getElementById('own-gallery-view').style.display === 'block';
    const foreignOpen = document.getElementById('foreign-profile-view').style.display === 'block';
    const traceOpen = document.getElementById('trace-view').style.display === 'block';
    if (!ownOpen && !foreignOpen && !traceOpen) {
      document.body.style.overflow = '';
    }
  }

  function showRandom() {
    // Aus trace.js geöffnete Bilder sind nicht browsable — sonst entstünde
    // eine Endlosschleife trace -> single view -> trace -> ... (siehe open()).
    // Doppelte Absicherung zum ausgeblendeten zBtn: greift auch, falls der
    // Klick trotzdem irgendwie ausgelöst wird (z.B. Tastenkürzel).
    if (!currentBrowsable) return;
    const images = currentContextImages || getImages();
    if (!images.length) return;
    const pick = images[Math.floor(Math.random() * images.length)];
    // Silent-Zustand (aus trace.js geöffnet) bleibt beim Weiterbrowsen
    // erhalten — sonst würde ein [z] mitten in einer stillen Sitzung
    // plötzlich doch einen History-Eintrag erzeugen.
    open(pick.id, null, { silent: wasSilentOpen });
  }

  // Echte Nutzeraktion (Klick/Taste) — im Unterschied zu close()-Aufrufen,
  // die intern vor einer Weiternavigation passieren (z.B. Puller-Chip-Klick),
  // aktualisiert das hier zusätzlich die URL (siehe router.js). Ausnahme:
  // wurde diese Sitzung still (aus trace.js) geöffnet, gibt es dafür keinen
  // History-Eintrag — schließen legt einfach die trace-Ansicht darunter wieder frei.
  escBtn.addEventListener('click', () => {
    const skipGoBack = wasSilentOpen;
    close();
    if (!skipGoBack) goBack();
  });
  zBtn.addEventListener('click', showRandom);

  let pullAnimationRunning = false;

  async function animatePullImage(username) {
    if (pullAnimationRunning) return;
    pullAnimationRunning = true;
    try {
      const startRect = imageEl.getBoundingClientRect();
      const clone = document.createElement('img');
      clone.src = imageEl.src;
      clone.style.objectFit = 'contain';

      await flyIntoCollection({
        cloneEl: clone,
        startRect,
        applyRect: (el, r) => {
          el.style.left = r.left + 'px';
          el.style.top = r.top + 'px';
          el.style.width = r.width + 'px';
          el.style.height = r.height + 'px';
        },
        transitionCss: 'left 0.4s ease, top 0.4s ease, width 0.4s ease, height 0.4s ease',
        getTargetRect: (labelRect) => getImageCornerRect(startRect, labelRect),
        onOpenCollection: () => onOpenProfile && onOpenProfile(username),
      });
    } finally {
      pullAnimationRunning = false;
    }
  }

  pullBtn.addEventListener('click', async () => {
    const user = getCurrentUser();
    if (!user) {
      onNeedsLogin();
      return;
    }
    if (!currentImage) return;

    if (isPulled) {
      const { error } = await supabase
        .from('pulls')
        .delete()
        .eq('user_id', user.id)
        .eq('image_id', currentImage.id);
      if (error) {
        console.error('Shove fehlgeschlagen:', error);
        flashMessage('error: could not drop');
        return;
      }
      isPulled = false;
      updatePullButtonStyle();
      showMessage('image dropped');
      [...commentsLayer.querySelectorAll('.username-color')]
        .filter((el) => el.textContent === user.username)
        .forEach((el) => el.remove());
    } else {
      const { error } = await supabase
        .from('pulls')
        .insert({ user_id: user.id, image_id: currentImage.id });
      if (error) {
        console.error('Pull fehlgeschlagen:', error);
        flashMessage('error: could not collect');
        return;
      }
      isPulled = true;
      updatePullButtonStyle();
      showMessage('added to collection');
      addPullerChip(user.username);
      animatePullImage(user.username);
    }

    if (onPullToggled) onPullToggled(currentImage.id, isPulled);
  });

  function enterMode(newMode) {
    mode = newMode;
    const dim = mode !== 'view';

    [imageEl, escBtn, zBtn, pullBtn, commentBtn, reportBtn, reproduceBtn, traceBtn, viewsEl].forEach((el) => {
      el.style.opacity = dim ? '0.2' : '1';
      el.style.pointerEvents = dim ? 'none' : 'auto';
    });
    commentsLayer.style.opacity = dim ? '0.2' : '1';
    setShootWordVisible(!dim);

    dimEsc.style.display = dim ? 'block' : 'none';
    typeInput.style.display = dim ? 'block' : 'none';
    submitBtn.style.display = dim ? 'block' : 'none';
    thanksEl.style.display = 'none';

    if (dim) {
      typeInput.value = '';
      typeInput.placeholder = 'type';
      typeInput.maxLength = CHAR_LIMIT;
      typeInput.classList.toggle('field-yellow', mode === 'comment');
      // Intern heißt der Modus weiterhin "comment" (siehe mode-Variable) —
      // angezeigt wird dafür "note", wie beim comment-Button selbst.
      submitBtn.textContent = mode === 'comment' ? 'note' : mode;

      const taken = [];

      const spotEsc = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spotEsc);
      dimEsc.style.left = spotEsc.x + 'px';
      dimEsc.style.top = spotEsc.y + 'px';
      clampFromRect(dimEsc, currentImageRect, IMAGE_SAFETY_PAD);
      clampToViewport(dimEsc, EDGE_SAFETY_PAD);

      const spotType = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spotType);
      typeInput.style.left = spotType.x + 'px';
      typeInput.style.top = spotType.y + 'px';
      clampFromRect(typeInput, currentImageRect, IMAGE_SAFETY_PAD);
      clampToViewport(typeInput, EDGE_SAFETY_PAD);

      const spotSubmit = randomSpot(taken, {
        margin: 60,
        avoidRect: currentImageRect,
        yRange: [0.6, 0.85],
      });
      taken.push(spotSubmit);
      submitBtn.style.left = spotSubmit.x + 'px';
      submitBtn.style.top = spotSubmit.y + 'px';
      clampFromRect(submitBtn, currentImageRect, IMAGE_SAFETY_PAD);
      clampToViewport(submitBtn, EDGE_SAFETY_PAD);

      repositionClock(taken, currentImageRect);

      requestAnimationFrame(() => typeInput.focus());
    }
  }

  commentBtn.addEventListener('click', () => {
    if (!getCurrentUser()) {
      onNeedsLogin();
      return;
    }
    enterMode('comment');
  });
  reportBtn.addEventListener('click', () => {
    if (!getCurrentUser()) {
      onNeedsLogin();
      return;
    }
    enterMode('report');
  });
  dimEsc.addEventListener('click', () => enterMode('view'));

  let reproduceRunning = false;

  reproduceBtn.addEventListener('click', async () => {
    if (!getCurrentUser()) {
      onNeedsLogin();
      return;
    }
    if (!currentImage || reproduceRunning) return;
    // Doppelte Absicherung zum ausgeblendeten Button (siehe updateReproduceVisibility).
    if ((currentImage.generation || 0) >= MAX_REPRODUCE_GENERATION) return;
    const sourceImage = currentImage; // vor close() sichern

    reproduceRunning = true;
    try {
      const { blob, width, height } = await createReproduction(sourceImage.url);
      // Einzelansicht verlassen wie bei [b] (kein neuer History-Eintrag für
      // das Upload-Overlay selbst — das war schon bei normalem push so).
      close();
      goBack();
      // Kein Tag-Übernehmen mehr: das Upload-Overlay startet komplett leer,
      // wie bei einem regulären Push (siehe upload.js).
      onReproduce && onReproduce(blob, { width, height, reproducedFromId: sourceImage.id });
    } catch (err) {
      console.error('Reproduce fehlgeschlagen:', err);
      flashMessage('error: could not reproduce');
    } finally {
      reproduceRunning = false;
    }
  });

  traceBtn.addEventListener('click', () => {
    if (!currentImage || !currentImage.familyRootId) return;
    const { familyRootId, id: returnImageId } = currentImage;
    // Direkt schließen (kein goBack) — trace.js übernimmt die Ansicht, siehe
    // dessen escBtn-Handler in main.js für den Rückweg zu diesem Bild.
    close();
    onOpenTrace && onOpenTrace(familyRootId, returnImageId);
  });

  let isSubmitting = false;

  function flashThanks(text) {
    thanksEl.textContent = text;
    thanksEl.style.display = 'block';
    thanksEl.style.transform = 'none';
    const spot = randomSpot([], { margin: 60, avoidRect: currentImageRect });
    thanksEl.style.left = spot.x + 'px';
    thanksEl.style.top = spot.y + 'px';
    clampFromRect(thanksEl, currentImageRect, IMAGE_SAFETY_PAD);
    clampToViewport(thanksEl, EDGE_SAFETY_PAD);
  }

  async function submit() {
    const val = typeInput.value.trim();
    const user = getCurrentUser();
    if (!val || !currentImage || isSubmitting || !user) return;

    isSubmitting = true;
    submitBtn.style.pointerEvents = 'none';
    submitBtn.style.opacity = '0.3';

    try {
      if (mode === 'comment') {
        const { data: inserted, error } = await supabase
          .from('comments')
          .insert({ image_id: currentImage.id, body: val, user_id: user.id })
          .select()
          .single();

        if (error) {
          console.error('Kommentar fehlgeschlagen:', error);
          flashMessage('error: note failed');
          return;
        }
        addCommentToLayer(inserted);
        enterMode('view');
        showRandomHint();
      } else if (mode === 'report') {
        const { error } = await supabase
          .from('reports')
          .insert({ target_type: 'image', target_id: currentImage.id, reason: val });

        if (error) {
          console.error('Report fehlgeschlagen:', error);
          flashMessage('error: report failed');
          return;
        }
        typeInput.style.display = 'none';
        submitBtn.style.display = 'none';
        enterMode('view');
      }
    } finally {
      isSubmitting = false;
      submitBtn.style.pointerEvents = 'auto';
      submitBtn.style.opacity = '1';
    }
  }

  // Kommentare: Klick ODER Enter bestätigt. Reports bewusst nur per Klick —
  // höhere Hürde, da nicht rückgängig machbar.
  submitBtn.addEventListener('click', submit);
  typeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && mode === 'comment') submit();
  });

  return {
    open,
    // Für das Routing (main.js): Ansicht schließen, ohne die goBack()-Logik
    // des escBtn-Klicks auszulösen — genutzt, wenn eine andere Route bereits
    // von außen vorgibt, dass diese Ansicht zu schließen ist.
    close,
    showRandom,
    // Für Fenstergrößenänderungen: nur die frei positionierten Textelemente
    // zurück in den sichtbaren Bereich holen — das Bild behält seine
    // ursprüngliche Größe (wird nicht neu berechnet, soll nicht schrumpfen).
    reposition: () => {
      if (overlay.style.display === 'block') positionActionWords();
    },
  };
}

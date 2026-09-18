import { fetchImageById, fetchRandomImage, incrementImageViews } from './images-repo.js';
import {
  clampToViewport, clampFromRect, computeContainRect, imageColumnRect,
} from './position-utils.js';
import { repositionClock, setClockVisible } from './clock.js';
import {
  pushRoute, replaceRoute, goBack, imagePath, HOME_PATH, HOME_TITLE,
} from './router.js';

// Sicherheitsabstand der frei platzierten Textelemente zur Bildfläche
// bzw. zum Bildschirmrand — großzügiger als der allgemeine Default,
// damit in der Einzelansicht nichts ins Bild hineinragt.
const IMAGE_SAFETY_PAD = 40;
const EDGE_SAFETY_PAD = 32;

function pad(n) {
  return String(n).padStart(2, '0');
}

// Volles Jahr (anders als die Uhr oben links, clock.js, die aus
// Platzgründen nur zwei Stellen zeigt) -- "pushed" ist eine einmalige
// Angabe pro Bild, kein laufend sichtbarer Hinweis, daher hier ausführlich.
function formatPushedAt(isoString) {
  const d = new Date(isoString);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Dateigröße wird nicht in der DB gespeichert (kein Schema-Feld dafür,
 * siehe images-repo.js) -- stattdessen per HEAD-Anfrage direkt beim Storage-
 * Bucket erfragt (Content-Length-Header, von Supabase per CORS freigegeben).
 * Funktioniert dadurch auch für Bilder, die vor Einführung dieser Anzeige
 * gepusht wurden, ohne Nachbearbeitung. Liefert null bei jedem Fehler (Netz,
 * fehlender Header, ...) -- infoSizeEl zeigt dann einfach nichts Genaueres an.
 */
async function fetchFileSize(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const bytes = parseInt(res.headers.get('content-length'), 10);
    return Number.isFinite(bytes) ? bytes : null;
  } catch (err) {
    return null;
  }
}

function formatFileSize(bytes) {
  return `${Math.round(bytes / 1024)}KB`;
}

/**
 * Erste Platzierung eines Textelements ausschließlich links oder rechts vom
 * Bild. Bewusst NICHT über randomSpot(avoidRect: imageColumnRect(...)):
 * randomSpot samplet x über die GESAMTE Fensterbreite und verwirft Treffer
 * in der Sperrzone -- auf schmalen Bildschirmen (Smartphone) nimmt das Bild
 * oft fast die ganze Breite ein, sodass der erlaubte Rest so schmal wird,
 * dass praktisch jeder Versuch scheitert und alle Elemente im selben
 * Fallback-Punkt kollidieren (beobachtet als "Textelemente überlagern sich
 * oben links"). Hier wird x stattdessen direkt aus der jeweils verfügbaren
 * Seiten-Zone gezogen -- bleibt dadurch auch bei sehr wenig seitlichem Platz
 * zuverlässig gültig.
 */
function randomColumnSpot(taken, imageRect, { margin = 24, minDist = 90 } = {}) {
  const sides = [];
  if (imageRect.left - margin * 2 > 4) {
    sides.push({ from: margin, to: imageRect.left - margin });
  }
  if (window.innerWidth - imageRect.right - margin * 2 > 4) {
    sides.push({ from: imageRect.right + margin, to: window.innerWidth - margin });
  }
  // Extremfall: kein Fenster ohne nennenswerte seitliche Restfläche (Bild
  // nimmt praktisch die volle Breite ein) -- notgedrungen ganz am Rand
  // platzieren, bleibt aber weiterhin über minDist im y voneinander getrennt
  // (siehe unten), statt komplett zu kollidieren.
  if (!sides.length) sides.push({ from: margin, to: margin });

  for (let attempt = 0; attempt < 40; attempt++) {
    const side = sides[Math.floor(Math.random() * sides.length)];
    const x = side.from + Math.random() * Math.max(0, side.to - side.from);
    const y = margin + Math.random() * (window.innerHeight - margin * 2);
    const farEnough = taken.every((p) => Math.hypot(p.x - x, p.y - y) > minDist);
    if (farEnough) return { x, y };
  }

  // Kein Punkt mit vollem Mindestabstand gefunden -- wenigstens im y nicht
  // mit bereits vergebenen Punkten kollidieren (x bleibt innerhalb der
  // Seiten-Zone, aber ohne Abstandsprüfung).
  const side = sides[Math.floor(Math.random() * sides.length)];
  const x = side.from + Math.random() * Math.max(0, side.to - side.from);
  let y = margin;
  taken.map((p) => p.y).sort((a, b) => a - b).forEach((usedY) => {
    if (Math.abs(usedY - y) < minDist) y = usedY + minDist;
  });
  return { x, y: Math.min(y, window.innerHeight - margin) };
}

// Bilder in der Galerie sind loading="lazy" — ein per [r] gezeigtes Bild
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

export function initSingleView(refs, getImages) {
  const {
    overlay, imageEl, escBtn, randomBtn, infoViewsEl, infoPushedEl,
    infoSizeEl, infoResolutionEl, countdownEl,
  } = refs;

  let currentImage = null;
  let currentImageRect = null;

  // Bild-Info (views/pushed, siehe imageEl-Klick-Listener unten) -- taucht
  // erst nach einem Klick auf das Bild auf und verschwindet bei erneutem
  // Klick wieder. Wird pro Bild neu gesetzt (siehe open()), nie live
  // aktualisiert -- ein zeitgleich von jemand anderem verursachter Aufruf
  // erhöht den Zähler in der DB zwar sofort, hier aber erst beim nächsten
  // eigenen Öffnen dieses Bildes sichtbar.
  let infoVisible = false;

  // Countdown bis zum automatischen Verschwinden aus main (img.expiresAt,
  // siehe upload.js Consent "circulate") -- anders als views/pushed IMMER
  // sichtbar, wenn gesetzt, kein Bild-Klick nötig.
  let countdownTimer = null;

  // Erhöht sich bei jeder zustandsändernden Aktion (open()/close()) — eine
  // asynchrone Anfrage, die währenddessen durch eine neuere Anfrage oder
  // eine Navigation überholt wurde, erkennt das daran und wendet ihr (dann
  // veraltetes) Ergebnis nicht mehr an.
  let openGeneration = 0;

  // Schiebt ein bereits positioniertes Element notfalls vom aktuellen Bild
  // weg — ohne es komplett neu zu würfeln. Genutzt, wenn die Position
  // eigentlich gehalten werden soll (z.B. beim Bildwechsel per [r]). Nutzt
  // die volle Spalte (siehe imageColumnRect), nicht nur die Bildfläche
  // selbst -- landet dadurch nie oberhalb/unterhalb des Bildes.
  function correctElementForImage(el) {
    clampFromRect(el, imageColumnRect(currentImageRect), IMAGE_SAFETY_PAD);
    clampToViewport(el, EDGE_SAFETY_PAD);
  }

  // views/pushed/size/resolution sind Teil derselben frei schwebenden
  // Wortgruppe wie z/r -- eigener Font (siehe .image-info in style.css),
  // aber gleiche Platzierungslogik, nicht mehr fest unter dem Bild
  // verankert.
  const infoWords = [escBtn, randomBtn, infoViewsEl, infoPushedEl, infoSizeEl, infoResolutionEl];

  function correctPositionsForImage() {
    infoWords.forEach(correctElementForImage);
    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
  }

  function positionActionWords() {
    const taken = [];
    infoWords.forEach((el) => {
      const spot = randomColumnSpot(taken, currentImageRect);
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      correctElementForImage(el);
    });
    repositionClock(taken, currentImageRect);
    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
  }

  function updateInfoVisibility() {
    const display = infoVisible ? 'block' : 'none';
    infoViewsEl.style.display = display;
    infoPushedEl.style.display = display;
    infoSizeEl.style.display = display;
    infoResolutionEl.style.display = display;
    // Während sie ausgeblendet sind, liefert getBoundingClientRect() ein
    // leeres Rechteck -- die Fein-Korrektur gegen Bild/Bildschirmrand
    // (correctElementForImage) konnte ihre tatsächliche Größe beim
    // ursprünglichen Platzieren also nicht kennen. Erst sobald sie sichtbar
    // werden, hier noch einmal gegen die jetzt echte Größe nachkorrigieren.
    if (infoVisible) {
      [infoViewsEl, infoPushedEl, infoSizeEl, infoResolutionEl].forEach(correctElementForImage);
    }
  }

  // Klick auf das Bild selbst schaltet die Info ein/aus -- kein separates
  // Textelement dafür nötig, das Bild ist bereits eindeutig als Ziel dieser
  // Aktion erkennbar.
  function toggleImageInfo() {
    infoVisible = !infoVisible;
    updateInfoVisibility();
  }

  imageEl.addEventListener('click', toggleImageInfo);

  // Über dem Bild verankert (nicht Teil der Views/Pushed-Zeilen darunter),
  // gleiche Stelle wie der Countdown im Upload-Fenster.
  function positionCountdown() {
    if (!currentImageRect) return;
    countdownEl.style.left = currentImageRect.left + 'px';
    countdownEl.style.top = (currentImageRect.top - 44) + 'px';
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEl.style.display = 'none';
  }

  // Läuft ab der real gespeicherten Ablauffrist (img.expiresAt, beim Push
  // gesetzt, siehe upload.js) -- anders als die Vorschau im Upload-Fenster
  // hier keine rein lokale Simulation, sondern der tatsächliche, für alle
  // Betrachtenden gleiche Countdown.
  function startCountdown(expiresAt) {
    const endAt = new Date(expiresAt).getTime();

    function tick() {
      const remaining = Math.max(0, endAt - Date.now());
      const totalSeconds = Math.ceil(remaining / 1000);
      const hh = Math.floor(totalSeconds / 3600);
      const mm = Math.floor((totalSeconds % 3600) / 60);
      const ss = totalSeconds % 60;
      countdownEl.textContent = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
      if (remaining <= 0) stopCountdown();
    }

    clearInterval(countdownTimer);
    countdownEl.style.display = 'block';
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // Zeigt den Countdown nur, wenn dieses Bild eine noch nicht abgelaufene
  // Ablauffrist hat -- ein bereits abgelaufenes Bild (z.B. über einen alten
  // geteilten Link noch erreichbar, obwohl main es nicht mehr listet, siehe
  // images-repo.js) zeigt keinen Countdown mehr.
  function updateCountdownForImage(img) {
    if (img.expiresAt && new Date(img.expiresAt).getTime() > Date.now()) {
      startCountdown(img.expiresAt);
      positionCountdown();
    } else {
      stopCountdown();
    }
  }

  async function open(imageId) {
    // Generation SOFORT beanspruchen, vor jedem await -- sonst könnten zwei
    // sich überschneidende open()-Aufrufe, die BEIDE fetchImageById() weiter
    // unten brauchen (Bild nicht in der bereits geladenen Liste), ihre
    // Generation in der falschen (Netzwerk-Antwortzeit- statt Aufruf-)
    // Reihenfolge zugewiesen bekommen.
    const myGeneration = ++openGeneration;
    const images = getImages();
    let img = images.find((i) => i.id === imageId);
    if (!img) {
      // Nicht in einer bereits geladenen Galerie-Liste (z.B. Direktaufruf
      // eines geteilten Links auf ein älteres Bild) — einzeln nachladen.
      img = await fetchImageById(imageId);
      if (!img) return;
    }

    // Galerie-Bilder sind loading="lazy" — bei [r] auf ein Bild, das noch nie
    // im Sichtbereich war, hat der Browser die Daten oft noch gar nicht
    // geladen. Ohne dieses Warten würde die Größe/URL des <img> sofort
    // umgestellt, während die Bilddaten noch unterwegs sind — sichtbar als
    // kurzes "springt auf falsche Größe, bevor das Bild da ist". Bis das neue
    // Bild bereitsteht, bleibt einfach das alte unverändert stehen.
    await preloadImage(img.url);
    if (myGeneration !== openGeneration) return; // zwischenzeitlich überholt (neueres [r] oder geschlossen)

    // Nur ein frischer Einstieg aus der Galerie bekommt eine neue zufällige
    // Anordnung der Textelemente — solange man (z.B. über mehrfaches [r])
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

    // Info (views/pushed) für DIESES Bild neu aufsetzen -- zunächst wieder
    // ausgeblendet (siehe toggleImageInfo), "pushed" steht sofort fest
    // (bereits geladen), "views" erst, sobald die Zählung zurückkommt.
    infoVisible = false;
    updateInfoVisibility();
    infoPushedEl.textContent = `pushed: ${formatPushedAt(img.createdAt)}`;
    infoViewsEl.textContent = 'views: …';
    incrementImageViews(img.id).then((count) => {
      if (myGeneration !== openGeneration) return; // überholt, siehe oben
      infoViewsEl.textContent = count != null ? `views: ${count}` : 'views: —';
    });
    // Auflösung steht sofort fest (bereits geladen, siehe images-repo.js),
    // die Dateigröße erst nach der HEAD-Anfrage (fetchFileSize).
    infoResolutionEl.textContent = `${img.naturalWidth}x${img.naturalHeight}px`;
    infoSizeEl.textContent = 'size: …';
    fetchFileSize(img.url).then((bytes) => {
      if (myGeneration !== openGeneration) return; // überholt, siehe oben
      infoSizeEl.textContent = bytes != null ? `size: ${formatFileSize(bytes)}` : 'size: —';
    });
    updateCountdownForImage(img);

    overlay.style.display = 'block';
    overlay.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    // Die globale Uhr (Datum/Uhrzeit oben links) wird in der Einzelansicht
    // bewusst nicht gezeigt -- an ihrer Stelle stehen hier stattdessen
    // views/pushed (jetzt Teil von positionActionWords/correctPositionsForImage
    // oben) und ggf. der Countdown (positionCountdown).
    setClockVisible(false);
    // Nur der frische Einstieg in die Einzelansicht ist ein eigener Schritt
    // im Browser-Verlauf — jeder Bildwechsel währenddessen (mehrfaches [r])
    // aktualisiert nur die URL (Reload/Teilen-Link) per replaceRoute, ohne
    // eigenen History-Eintrag. Dadurch bleibt es bei GENAU einem Eintrag für
    // eine ganze Einzelansicht-"Sitzung" — [z] (goBack()) führt daher immer
    // direkt zurück zur Hauptgalerie.
    if (wasAlreadyOpen) {
      replaceRoute(imagePath(img.id), `push v.r.p. — image ${img.id}`);
    } else {
      pushRoute(imagePath(img.id), `push v.r.p. — image ${img.id}`);
    }

    if (!wasAlreadyOpen) {
      positionActionWords();
    } else {
      // Position halten (siehe [r]-Verhalten), aber vor Überlappung mit dem
      // neuen — möglicherweise anders geformten — Bild schützen.
      correctPositionsForImage();
    }
  }

  function close() {
    openGeneration += 1; // verwirft eine evtl. noch wartende Anfrage (siehe oben)
    overlay.style.display = 'none';
    currentImage = null;
    currentImageRect = null;
    infoVisible = false;
    updateInfoVisibility();
    stopCountdown();
    document.body.style.overflow = '';
  }

  // Zieht aus dem GESAMTEN Bestand (fetchRandomImage), nicht nur aus den in
  // der Hauptgalerie gerade geladenen Bildern (getImages()) -- sonst hätten
  // frühe Uploads, bis zu denen main nie durchgescrollt wurde, nie eine
  // Chance getroffen zu werden.
  async function showRandom() {
    const img = await fetchRandomImage();
    if (!img) return;
    open(img.id);
  }

  // [z]/[esc] aus der normalen Einzelansicht führt IMMER direkt zur
  // Hauptgalerie -- unabhängig davon, auf welchem Weg man hierher kam.
  // Bewusst pushRoute(HOME_PATH) statt goBack()/history.back().
  escBtn.addEventListener('click', () => {
    close();
    pushRoute(HOME_PATH, HOME_TITLE);
  });
  randomBtn.addEventListener('click', showRandom);

  return {
    open,
    close,
    showRandom,
    // Für Fenstergrößenänderungen.
    reposition: () => {
      if (overlay.style.display === 'block') {
        positionActionWords();
        positionCountdown();
      }
    },
  };
}

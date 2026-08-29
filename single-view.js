import { fetchImageById, fetchAllImages } from './images-repo.js';
import { createConnection, fetchConnectedImages, fetchPoolForImages } from './connections-repo.js';
import { createSeries, fetchSeriesById } from './series-repo.js';
import {
  computeChronologicalLayout, computeSeriesLayout, computeConnectPreviewLayout, EDGE_MARGIN,
  CONNECT_PREVIEW_MOBILE_BREAKPOINT,
} from './layout-engine.js';
import { randomSpot, clampToViewport, clampFromRect, computeContainRect } from './position-utils.js';
import { BASE_SIDE } from './image-config.js';
import { repositionClock, setClockVisible } from './clock.js';
import {
  pushRoute, replaceRoute, goBack, imagePath, connectPath, seriesPath, HOME_PATH, HOME_TITLE,
} from './router.js';
import { flashMessage } from './feedback.js';

// Sicherheitsabstand der frei platzierten Textelemente zur Bildfläche
// bzw. zum Bildschirmrand — großzügiger als der allgemeine Default,
// damit in der Einzelansicht nichts ins Bild hineinragt.
const IMAGE_SAFETY_PAD = 40;
const EDGE_SAFETY_PAD = 32;

// "connect": geräte-/sitzungsbasierte Abklingzeit (localStorage, unabhängig
// vom jeweiligen Bild) -- gilt für den Start einer neuen, unabhängigen
// Basis-Verbindung aus der normalen Einzelansicht heraus (openConnectSelect()).
// Das Fortsetzen/Bearbeiten einer Reihe (Diptychon-/Reihen-Ansicht) läuft
// danach ausschließlich über den Pool (fetchPoolForImages) -- nie mehr über
// createConnection() -- der Cooldown kommt dabei also gar nicht mehr ins
// Spiel, ganz ohne Sonderfall-Erkennung.
const CONNECT_COOLDOWN_MS = 5000;
const CONNECT_COOLDOWN_KEY = 'push_connect_last';

function connectCooldownRemaining() {
  const last = parseInt(localStorage.getItem(CONNECT_COOLDOWN_KEY) || '0', 10);
  return Math.max(0, CONNECT_COOLDOWN_MS - (Date.now() - last));
}

function markConnectCooldown() {
  localStorage.setItem(CONNECT_COOLDOWN_KEY, String(Date.now()));
}

/**
 * Die frei schwebenden Textelemente der Einzelansicht (z, r, c) sollen
 * ausschließlich links oder rechts vom Bild landen, nie darüber/darunter.
 * Dazu wird nicht die Bildfläche selbst als Sperrzone an randomSpot()/
 * clampFromRect() übergeben, sondern eine virtuelle "Spalte" mit derselben
 * x-Spanne wie das Bild, aber über die GESAMTE Fensterhöhe (statt nur über
 * die Bildhöhe) -- jede y-Koordinate innerhalb dieser x-Spanne gilt damit
 * als gesperrt, nicht nur die y-Koordinaten, die das Bild tatsächlich
 * einnimmt. clampFromRect() wählt bei der Korrektur immer die kürzeste
 * Ausweichrichtung -- bei einer randlos hohen Sperrzone ist das automatisch
 * immer links oder rechts, nie hoch/runter.
 */
function imageColumnRect(rect) {
  if (!rect) return null;
  return { left: rect.left, right: rect.right, top: 0, bottom: window.innerHeight };
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

export function initSingleView(refs, getImages, getSortMode, onSeriesSaved) {
  const {
    overlay, imageEl, escBtn, randomBtn, connectBtn, pushBtn, connectionsStage,
    seriesOverlay, seriesStage, seriesPickerEl, seriesPickerInnerEl, seriesCandidates, seriesEsc, seriesConfirmWord, seriesFixEl,
    seriesSEl, seriesAEl, seriesRandomEl, seriesPushEl,
  } = refs;

  let currentImage = null;
  let currentImageRect = null;
  let currentContextImages = null; // welche Liste "r" gerade durchsucht

  // Erhöht sich bei jeder zustandsändernden Aktion (open()/close(), Reihe
  // betreten/bearbeiten/speichern) — eine asynchrone Anfrage, die
  // währenddessen durch eine neuere Anfrage oder eine Navigation überholt
  // wurde, erkennt das daran und wendet ihr (dann veraltetes) Ergebnis nicht
  // mehr an. Gemeinsamer Zähler für Einzelansicht UND Reihen-Ansicht, da nie
  // beide gleichzeitig aktiv sind.
  let openGeneration = 0;

  let connectCooldownTimer = null;

  // ─────────────────────────────────────────────
  // "connect" -- Reihen-Zustand. Eine noch nicht gespeicherte Reihe ist
  // reiner Client-/Sitzungszustand: seriesIds/seriesImages sind die aktuelle
  // Zusammenstellung (Reihenfolge = Hinzufüge-Reihenfolge, kann sich durch
  // Entfernen+Neuhinzufügen ändern). baseConnectionIds hält die PERMANENTE
  // Basis-Verbindung (die zwei Bilder, über die diese Bau-Sitzung betreten
  // wurde) fest -- ändert sich NIE während des Bauens, auch nicht durch
  // Entfernen/Hinzufügen über den Pool, und bestimmt die Route
  // (connectPath()). pendingCandidate existiert nur VOR der allerersten
  // Verbindung (Auswahl getroffen, aber createConnection() noch nicht
  // ausgeführt). seriesReadOnly=true für eine bereits gespeicherte,
  // schreibgeschützte Reihe (kein Pool, kein "fix", kein Entfernen).
  // ─────────────────────────────────────────────
  let seriesIds = [];
  let seriesImages = [];
  let pendingCandidate = null;
  let baseConnectionIds = null;
  let seriesReadOnly = false;
  let fixArmed = false; // zweistufiges "g" -> "create gallery" -> Aktion (siehe seriesFixEl unten)
  let fixArmTimer = null; // setzt "fix" nach FIX_ARM_TIMEOUT_MS automatisch zurück, siehe armFix/disarmFix

  // Zuletzt tatsächlich gerenderte Anordnung im Bau-Modus ({ containerWidth,
  // totalHeight, positions }, siehe renderSeriesStage) -- wird beim Fixieren
  // 1:1 als layout gespeichert (siehe handleFixClick), statt sie erneut und
  // damit anders zu berechnen.
  let lastSeriesRender = null;

  // Eingefrorene Anordnung einer bereits gespeicherten Reihe (aus
  // fetchSeriesById, siehe openSavedSeries) -- { containerWidth,
  // totalHeight, positions: [{id,left,top,width,height}, ...] }, oder null
  // bei einer vor Einführung dieses Felds gespeicherten Reihe (Fallback auf
  // die normale, live berechnete Anordnung, siehe renderSeriesStage).
  let seriesSavedLayout = null;

  // Echte Hinzufüge-Reihenfolge (Bild-IDs) -- getrennt von seriesIds
  // gehalten, weil shuffleSeries() seriesIds/seriesImages selbst umsortiert
  // (das IST ja die gemischte Anzeige/Speicher-Reihenfolge). Wächst nur durch
  // addFromPool (immer ans Ende angehängt) und schrumpft nur durch
  // removeFromSeries -- wird selbst NIE umsortiert. "a" (arrangeSeriesOrder)
  // setzt seriesIds/seriesImages anhand dieser Liste zurück.
  let seriesAddOrderIds = [];

  // "s"/"a" während des Bau-Modus: wie auf der Hauptgalerie eine rein
  // clientseitige Sortieranzeige -- hier aber mit echter Bedeutung, da die
  // Reihenfolge selbst der Inhalt der Reihe ist (wird beim Fixieren 1:1 als
  // image_ids gespeichert, siehe handleFixClick). 'chronological' meint hier
  // "in der Reihenfolge, in der die Bilder der Reihe hinzugefügt wurden"
  // (seriesAddOrderIds) -- NICHT nach created_at der Bilder selbst, anders
  // als der gleichnamige Modus auf der Hauptgalerie. Der Ausgangszustand
  // beim Betreten des Bau-Modus (Hinzufüge-Reihenfolge) gilt ebenfalls als
  // 'chronological'.
  let seriesSortMode = 'chronological';

  // Feste Ziel-Bildgröße für die Reihen-Ansicht (computeSeriesLayout) --
  // entspricht der Größe, die früher bei der "+"/-"-Zoomfunktion nach zwei
  // Klicks auf "+" ausgehend von der kleinsten Stufe erschien (die
  // Zoomfunktion selbst wurde wieder entfernt, dieser eine Wert bleibt als
  // fixe Vorgabe bestehen). BASE_SIDE (image-config.js) als Untergrenze --
  // dieselbe Referenz wie "so groß wie auf main".
  function seriesTargetSide(containerWidth) {
    return Math.max(BASE_SIDE, containerWidth * 0.22);
  }

  // Schiebt ein bereits positioniertes Element notfalls vom aktuellen Bild
  // weg — ohne es komplett neu zu würfeln. Genutzt, wenn die Position
  // eigentlich gehalten werden soll (z.B. beim Bildwechsel per [r]). Nutzt
  // die volle Spalte (siehe imageColumnRect), nicht nur die Bildfläche
  // selbst -- landet dadurch nie oberhalb/unterhalb des Bildes.
  function correctElementForImage(el) {
    clampFromRect(el, imageColumnRect(currentImageRect), IMAGE_SAFETY_PAD);
    clampToViewport(el, EDGE_SAFETY_PAD);
  }

  function correctPositionsForImage() {
    [escBtn, randomBtn, connectBtn, pushBtn].forEach(correctElementForImage);
    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
  }

  function positionActionWords() {
    const taken = [];
    [escBtn, randomBtn, connectBtn, pushBtn].forEach((el) => {
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

  // "c" ist ausgeblendet, solange die geräteweite Abklingzeit noch läuft
  // (unabhängig vom aktuell gezeigten Bild) — plant sich selbst neu ein,
  // damit "c" auch ohne erneutes open() automatisch wieder erscheint.
  function updateConnectVisibility() {
    const remaining = connectCooldownRemaining();
    connectBtn.style.display = remaining > 0 ? 'none' : 'block';
    if (connectCooldownTimer) clearTimeout(connectCooldownTimer);
    if (remaining > 0) {
      connectCooldownTimer = setTimeout(updateConnectVisibility, remaining);
    }
  }

  function clearConnectionsStage() {
    connectionsStage.innerHTML = '';
    connectionsStage.style.marginTop = (currentImageRect.bottom + 60) + 'px';
    connectionsStage.style.minHeight = '0px';
  }

  // Wiederverwendet computeChronologicalLayout (dieselbe organische
  // Anordnung wie die Hauptgalerie, gleiche Bildgröße wie computeDisplaySize()
  // sie überall liefert) -- ohne Shuffle-Möglichkeit. Gemeinsam genutzt von
  // den verbundenen Bildern unter der normalen Einzelansicht UND dem Pool
  // unterhalb einer Reihe (siehe loadPool) -- beide sollen laut
  // Spezifikation identisch aussehen.
  // reserved wird durchgereicht (siehe computeChronologicalLayout) --
  // ungesetzt gilt deren eigener Default (die Hauptgalerie-Konsolen-Zone
  // oben links). Die schmale, rechte Auswahl-Spalte (loadConnectPicker)
  // übergibt stattdessen {width:0, height:0}, da dort keine fixe Konsole
  // sitzt und die Standard-Reservierung ihr sonst unnötig viel Platz nähme.
  function renderImageCluster(stageEl, images, onImageClick, reserved) {
    stageEl.innerHTML = '';
    if (!images.length) {
      stageEl.style.minHeight = '0px';
      return;
    }
    const width = stageEl.clientWidth || window.innerWidth;
    const { positions, heightmap } = computeChronologicalLayout(images, width, reserved);
    images.forEach((img) => {
      const el = document.createElement('img');
      el.className = 'push-image';
      el.dataset.imageId = img.id;
      el.loading = 'lazy';
      el.decoding = 'async';
      el.src = img.url;
      el.style.width = img.width + 'px';
      el.style.height = img.height + 'px';
      const pos = positions.get(img.id);
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      el.style.zIndex = pos.z;
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => onImageClick(img));
      stageEl.appendChild(el);
    });
    stageEl.style.minHeight = (Math.max(...heightmap) + EDGE_MARGIN) + 'px';
  }

  // Klick öffnet die Diptychon-/Reihen-Ansicht für genau diese Kante
  // (Ausgangsbild + Klickziel), nicht mehr die normale Einzelansicht des
  // verbundenen Bildes -- der Bezug zum Ausgangsbild soll dabei erhalten
  // bleiben statt verloren zu gehen.
  function renderConnectedImages(sourceImg, images) {
    clearConnectionsStage();
    renderImageCluster(connectionsStage, images, (img) => openSeriesFromPair(sourceImg, img));
  }

  async function open(imageId, imagesList) {
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
    // Galerie-Bilder sind loading="lazy" — bei [r] auf ein Bild, das noch nie
    // im Sichtbereich war, hat der Browser die Daten oft noch gar nicht
    // geladen. Ohne dieses Warten würde die Größe/URL des <img> sofort
    // umgestellt, während die Bilddaten noch unterwegs sind — sichtbar als
    // kurzes "springt auf falsche Größe, bevor das Bild da ist". Bis das neue
    // Bild bereitsteht, bleibt einfach das alte unverändert stehen.
    await preloadImage(img.url);
    if (myGeneration !== openGeneration) return; // zwischenzeitlich überholt (neueres [r] oder geschlossen)

    // Nur ein frischer Einstieg aus der Galerie bekommt eine neue zufällige
    // Anordnung der Textelemente — solange man (z.B. über mehrfaches [r]
    // oder über verbundene Bilder) in der Einzelansicht bleibt, halten sie
    // ihre Position.
    const wasAlreadyOpen = overlay.style.display === 'block';

    // Defensiv: falls diese Anfrage von einer anderen Routen-Art herkommt
    // (z.B. direkter Sprung von einer connect-Reihe auf eine Bild-Route,
    // siehe main.js/syncViewToRoute), muss deren Ansicht weichen.
    seriesOverlay.style.display = 'none';

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
    // Nur der frische Einstieg in die Einzelansicht ist ein eigener Schritt
    // im Browser-Verlauf — jeder Bildwechsel währenddessen (mehrfaches [r],
    // Rückkehr aus einem connect-Vorgang) aktualisiert nur die URL (Reload/
    // Teilen-Link) per replaceRoute, ohne eigenen History-Eintrag. Dadurch
    // bleibt es bei GENAU einem Eintrag für eine ganze Einzelansicht-
    // "Sitzung" — [z] (goBack()) führt daher immer direkt zurück zur
    // Hauptgalerie.
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
    updateConnectVisibility();

    clearConnectionsStage();
    fetchConnectedImages(img.id).then((connected) => {
      if (myGeneration !== openGeneration) return; // überholt, siehe oben
      renderConnectedImages(img, connected);
    });
  }

  function close() {
    openGeneration += 1; // verwirft eine evtl. noch wartende Anfrage (siehe oben)
    overlay.style.display = 'none';
    seriesOverlay.style.display = 'none';
    currentImage = null;
    currentImageRect = null;
    currentContextImages = null;
    seriesIds = [];
    seriesImages = [];
    seriesAddOrderIds = [];
    pendingCandidate = null;
    baseConnectionIds = null;
    seriesReadOnly = false;
    fixArmed = false;
    clearTimeout(fixArmTimer);
    fixArmTimer = null;
    seriesSortMode = 'chronological';
    lastSeriesRender = null;
    seriesSavedLayout = null;
    document.body.style.overflow = '';
  }

  function showRandom() {
    const images = currentContextImages || getImages();
    if (!images.length) return;
    const pick = images[Math.floor(Math.random() * images.length)];
    open(pick.id, null);
  }

  // [z]/[esc] aus der normalen Einzelansicht führt IMMER direkt zur
  // Hauptgalerie -- unabhängig davon, auf welchem Weg man hierher kam (auch
  // aus einem Diptychon oder einer Reihe heraus, siehe removeFromSeries/
  // renderSeriesStage weiter unten, die beide open() aufrufen). Bewusst
  // pushRoute(HOME_PATH) statt goBack()/history.back(): letzteres würde bei
  // einer verschachtelten Herkunft nur EINE Ebene zurückgehen (z.B. zurück
  // ins Diptychon) statt direkt zu main, wie hier explizit gewünscht.
  escBtn.addEventListener('click', () => {
    close();
    pushRoute(HOME_PATH, HOME_TITLE);
  });
  randomBtn.addEventListener('click', showRandom);
  connectBtn.addEventListener('click', () => openConnectSelect());

  // ─────────────────────────────────────────────
  // "connect" — Auswahl für die ALLERERSTE Basis-Verbindung. Das Basisbild
  // erscheint SOFORT in seiner künftigen Diptychon-Position/-größe (siehe
  // renderSeriesStage, computeConnectPreviewLayout) -- kein Sprung, sobald
  // später ein Kandidat gewählt wird. Die Auswahl-Galerie (fetchAllImages,
  // nicht die paginierte Hauptliste) läuft ausschließlich in der rechten
  // Bildschirmhälfte, in Hauptgalerie-Größe (siehe #connect-series-picker
  // in style.css, renderImageCluster). Sobald eine Reihe existiert (ab 2
  // Bildern), wächst sie ausschließlich über den Pool (siehe weiter unten),
  // nie mehr über diesen Auswahl-Flow.
  // ─────────────────────────────────────────────

  // Auswahl-Galerie (alle Bilder außer dem aktuellen Basisbild) in der
  // rechten Spalte -- dieselbe Größe/Anordnung wie die verbundenen Bilder
  // unter der normalen Einzelansicht (siehe renderImageCluster), hier durch
  // #connect-series-picker (style.css) auf die rechte Bildschirmhälfte
  // begrenzt. sourceId wird bei jedem Aufruf frisch aus seriesImages[0]
  // gelesen, nicht als Parameter erwartet -- die Basis kann sich durch
  // promotePendingCandidate() zwischenzeitlich geändert haben.
  // Auf dem Smartphone (Containerbreite unter CONNECT_PREVIEW_MOBILE_BREAKPOINT,
  // siehe layout-engine.js und die Media-Query in style.css) steht die
  // Auswahl-Galerie unterhalb des Ausgangsbildes statt daneben -- "top" muss
  // dafür dynamisch direkt unter das TATSÄCHLICH gerenderte Ausgangsbild
  // gesetzt werden (dessen Höhe hängt vom Seitenverhältnis ab, siehe
  // computeConnectPreviewLayout). Wirkt wie eine unsichtbare Linie: der
  // Picker (position:fixed, overflow-y:auto) rendert/scrollt nie oberhalb
  // dieser Grenze, das Ausgangsbild bleibt beim Scrollen der Galerie also
  // immer unverdeckt. Auf dem Desktop wird "top" bewusst zurückgesetzt,
  // damit dort wieder der CSS-Standard (0, rechte Spalte) gilt.
  function updatePickerTopOffset() {
    if (window.innerWidth >= CONNECT_PREVIEW_MOBILE_BREAKPOINT) {
      seriesPickerEl.style.top = '';
      return;
    }
    const baseEl = seriesStage.querySelector('[data-image-id]');
    if (!baseEl) return;
    const rect = baseEl.getBoundingClientRect();
    seriesPickerEl.style.top = (rect.bottom + 24) + 'px';
  }

  async function loadConnectPicker() {
    const sourceId = seriesImages[0].id;
    const myGeneration = openGeneration; // siehe open() -- verwirft ein überholtes Ergebnis
    const pool = await fetchAllImages();
    if (myGeneration !== openGeneration) return; // zwischenzeitlich geschlossen/weiternavigiert

    // fetchAllImages() liefert bei einem Netzwerk-/Serverfehler [] zurück
    // (wirft nie, siehe images-repo.js) -- ohne diese Prüfung bliebe die
    // rechte Spalte sonst leer, ohne jede Rückmeldung. Ein echtes "0 Bilder
    // in der DB" kommt hier praktisch nicht vor: das Basisbild selbst
    // müsste dafür ja existieren.
    if (!pool.length) {
      flashMessage('error: could not load images');
      close();
      open(sourceId);
      return;
    }

    const candidates = pool.filter((img) => img.id !== sourceId);
    updatePickerTopOffset();
    seriesPickerEl.style.display = 'block';
    renderImageCluster(seriesPickerInnerEl, candidates, (img) => selectCandidate(img), { width: 0, height: 0 });
  }

  // Auswahl-Galerie nur sichtbar, solange noch kein Kandidat gewählt ist --
  // sobald pendingCandidate gesetzt ist, zeigt renderSeriesStage stattdessen
  // das Diptychon (Basis + Kandidat, siehe dort). display:none statt nur
  // leerem Inhalt -- ein leerer, aber weiterhin vorhandener
  // #connect-series-picker läge sonst (unsichtbar) über der rechten
  // Bildschirmhälfte und würde dort Klicks auf das rechte Diptychon-Bild
  // abfangen (siehe style.css).
  function updatePickerVisibility() {
    if (pendingCandidate) {
      seriesPickerEl.style.display = 'none';
      seriesPickerInnerEl.innerHTML = '';
    } else {
      loadConnectPicker();
    }
  }

  // Startet einen komplett neuen, unabhängigen Connect-Vorgang aus der
  // normalen Einzelansicht heraus -- einzige Stelle, an der die Abklingzeit
  // geprüft wird (siehe Kommentar bei CONNECT_COOLDOWN_MS oben).
  function openConnectSelect() {
    if (!currentImage || connectCooldownRemaining() > 0) return; // doppelte Absicherung zum ausgeblendeten Button
    // Vollständiger Reset des Reihen-Zustands, nicht nur der drei Felder
    // unten -- dieser Einstiegspunkt für eine komplett neue Connect-Sitzung
    // soll sich nicht darauf verlassen, dass jeder mögliche vorherige Pfad
    // baseConnectionIds/seriesReadOnly/etc. bereits korrekt zurückgesetzt hat.
    pendingCandidate = null;
    seriesIds = [currentImage.id];
    seriesImages = [currentImage];
    seriesAddOrderIds = [];
    baseConnectionIds = null;
    seriesReadOnly = false;
    fixArmed = false;
    seriesSortMode = 'chronological';
    lastSeriesRender = null;
    seriesSavedLayout = null;
    overlay.style.display = 'none';
    seriesOverlay.style.display = 'block';
    seriesOverlay.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    setClockVisible(true);
    // Erst rendern, dann positionieren -- siehe Kommentar in
    // enterSeriesBuildMode.
    renderSeriesView();
    positionSeriesWords();
  }

  // Bild in der Auswahl-Galerie gewählt -- noch nicht bestätigt/
  // geschrieben, erscheint als pendingCandidate rechts neben dem Basisbild
  // im Diptychon (siehe renderSeriesStage).
  function selectCandidate(img) {
    pendingCandidate = img;
    renderSeriesView();
    positionSeriesWords();
  }

  // Klick auf das linke (Basis-)Bild des Diptychons VOR der ersten
  // Bestätigung: der gewählte Kandidat rutscht nach links und wird die neue
  // Basis, die rechte Spalte zeigt danach wieder die Auswahl-Galerie für
  // ein neues zweites Bild.
  function promotePendingCandidate() {
    if (!pendingCandidate) return;
    seriesImages = [pendingCandidate];
    seriesIds = [pendingCandidate.id];
    pendingCandidate = null;
    renderSeriesView();
    positionSeriesWords();
  }

  // Klick auf das rechte (Kandidaten-)Bild des Diptychons VOR der ersten
  // Bestätigung: der Kandidat wird verworfen, die Basis links bleibt
  // stehen, die rechte Spalte zeigt wieder die Auswahl-Galerie.
  function discardPendingCandidate() {
    if (!pendingCandidate) return;
    pendingCandidate = null;
    renderSeriesView();
    positionSeriesWords();
  }

  // ─────────────────────────────────────────────
  // "connect" — Diptychon-/Reihen-Ansicht. Bedient drei Zustände:
  //  1. Auswahl für die allererste Verbindung (baseConnectionIds noch null):
  //     links das Basisbild in Diptychon-Position/-größe, rechts entweder
  //     die Auswahl-Galerie (kein pendingCandidate) oder der gewählte
  //     Kandidat (pendingCandidate gesetzt) -- siehe
  //     loadConnectPicker/selectCandidate/promotePendingCandidate/
  //     discardPendingCandidate weiter oben.
  //  2. Bau-Modus einer noch nicht gespeicherten Reihe (baseConnectionIds
  //     gesetzt, seriesReadOnly=false) -- wächst ausschließlich über den
  //     Pool, jedes Bild kann per Klick wieder entfernt werden.
  //  3. Eine bereits gespeicherte, schreibgeschützte Reihe (seriesReadOnly=
  //     true) -- rein lesend, kein Pool, kein "fix", kein Entfernen.
  // ─────────────────────────────────────────────

  // Meidet nach Möglichkeit, ein Textelement über einem bereits platzierten
  // Bild landen zu lassen (siehe avoidRects in randomSpot,
  // position-utils.js) -- deshalb bewusst NACH renderSeriesView()/
  // renderSeriesStage() aufgerufen, wenn die Bilder schon im DOM stehen
  // (siehe Aufrufstellen). Bei einer dichten Reihe kann der Bildschirm
  // dabei so vollständig belegt sein, dass kein bildfreier Platz mehr
  // existiert -- randomSpot() fällt dann auf seinen normalen Fallback
  // zurück, das bleibt der akzeptierte Ausnahmefall, keine harte Garantie.
  // margin: 90 statt des randomSpot()-Standards -- consistent mit den
  // übrigen, großzügigeren Rändern der Reihen-Ansicht (siehe
  // SERIES_EDGE_MARGIN_* in layout-engine.js), damit Textelemente nie zu
  // nah am Bildschirmrand kleben.
  function positionSeriesWords() {
    const imageRects = [...seriesStage.querySelectorAll('[data-image-id]')].map((el) => el.getBoundingClientRect());
    const taken = [];
    [seriesEsc, seriesConfirmWord, seriesFixEl, seriesSEl, seriesAEl, seriesRandomEl, seriesPushEl].forEach((el) => {
      const spot = randomSpot(taken, { margin: 90, avoidRects: imageRects });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
    // Die Uhr (siehe clock.js) wurde bisher hier nie einbezogen -- blieb
    // beim Betreten von Diptychon/Reihe einfach an ihrer alten Position aus
    // der vorherigen Ansicht stehen, ohne Rücksicht auf die neuen Bilder/
    // Wörter hier.
    repositionClock(taken, null, imageRects);
  }

  // Leichte Korrektur statt kompletter Neuplatzierung -- für den Wechsel
  // zwischen bereits gespeicherten Reihen per [r] (siehe showRandomSeries):
  // die Textelemente sollen dabei stabil stehen bleiben, genau wie [r] in
  // der normalen Einzelansicht (dort correctPositionsForImage() statt
  // positionActionWords(), siehe open()). Da eine Reihe -- anders als das
  // eine Bild dort -- beliebig viele, über den ganzen Schirm verstreute
  // Bilder haben kann, reicht ein einzelnes avoidRect nicht: stattdessen wird
  // pro Bild einzeln herausgeschoben (clampFromRect), mehrfach durchlaufen,
  // da das Ausweichen vor einem Bild in ein anderes hineinschieben kann --
  // bestes Bemühen, keine harte Garantie (wie clampFromRect es generell ist).
  function correctSeriesWordsForImages() {
    const imageRects = [...seriesStage.querySelectorAll('[data-image-id]')].map((el) => el.getBoundingClientRect());
    const els = [seriesEsc, seriesConfirmWord, seriesFixEl, seriesSEl, seriesAEl, seriesRandomEl, seriesPushEl];
    const clockEl = document.getElementById('global-clock');
    if (clockEl) els.push(clockEl);
    els.forEach((el) => {
      for (let pass = 0; pass < 3; pass++) {
        imageRects.forEach((rect) => clampFromRect(el, rect, 20));
      }
      clampToViewport(el);
    });
  }

  // Sicherheitsnetz gegen zu hohe Bilder in der Reihen-Ansicht -- dieselbe
  // Höhen-Fraktion wie computeContainRect() für die normale Einzelansicht
  // (dort maxHeightFrac, siehe position-utils.js). Alle Bilder bekommen dort
  // primär dieselbe Bildfläche (siehe computeSeriesLayout), nicht dieselbe
  // Höhe wie in der Einzelansicht -- dieser Wert greift nur als Obergrenze
  // für einzelne, extrem lang gezogene Formate.
  const SERIES_MAX_IMAGE_HEIGHT_FRAC = 0.55;

  // Reine Darstellung: Reihe (+ ggf. pendingCandidate) neu zeichnen,
  // komplett neu aus seriesImages/pendingCandidate abgeleitet -- kein
  // inkrementelles Update, die Reihe ist ohnehin komplett im DOM. Klick auf
  // ein bereits bestätigtes Bild entfernt es aus der Reihe (Bau-Modus) -- in
  // der schreibgeschützten Ansicht einer gespeicherten Reihe ist nichts
  // davon anklickbar.
  //
  // Die Vorschau vor der allerersten Bestätigung (pendingCandidate gesetzt)
  // nutzt bewusst das statische, ruhige computeConnectPreviewLayout statt
  // der organischen Reihen-Streuung -- eigener, stabilerer Charakter für
  // diesen kurzen Moment vor dem eigentlichen Connect (siehe dort).
  function renderSeriesStage() {
    seriesStage.innerHTML = '';
    const displayImages = pendingCandidate ? [...seriesImages, pendingCandidate] : seriesImages;
    const width = seriesStage.clientWidth || window.innerWidth;
    let positions;
    let totalHeight;

    // Vor der ALLERERSTEN echten Verbindung (baseConnectionIds noch null)
    // gilt immer das statische, ruhige computeConnectPreviewLayout -- sowohl
    // für das einzelne Basisbild (noch kein Kandidat gewählt, rechte Spalte
    // zeigt die Auswahl-Galerie) als auch für Basis+Kandidat zusammen
    // (dieselbe Größe/Position für die Basis in beiden Fällen, siehe
    // computeConnectPreviewLayout -- kein Sprung, sobald ein Kandidat
    // hinzukommt). Erst ab einer echten Basis-Verbindung (enterSeriesBuildMode)
    // greift die organische, freie Reihen-Streuung.
    const isInitialConnectPhase = !seriesReadOnly && baseConnectionIds === null;

    if (seriesReadOnly && seriesSavedLayout) {
      // Eingefrorene Anordnung von handleFixClick (siehe dort) -- rein
      // proportional auf die aktuelle Fensterbreite skaliert, wie bei einem
      // Screenshot. Kein computeSeriesLayout-Aufruf hier -- das würde jedes
      // Mal neu (und zufällig) platzieren, genau das soll eine fixierte
      // Reihe ja nicht mehr tun.
      const scale = width / seriesSavedLayout.containerWidth;
      positions = new Map();
      seriesSavedLayout.positions.forEach((p) => {
        positions.set(p.id, {
          left: p.left * scale,
          top: p.top * scale,
          width: p.width * scale,
          height: p.height * scale,
        });
      });
      totalHeight = seriesSavedLayout.totalHeight * scale;
    } else {
      const maxImageHeight = window.innerHeight * SERIES_MAX_IMAGE_HEIGHT_FRAC;
      const targetSide = seriesTargetSide(width);
      const computed = isInitialConnectPhase
        ? computeConnectPreviewLayout(displayImages, width, maxImageHeight)
        : computeSeriesLayout(displayImages, width, maxImageHeight, targetSide);
      positions = computed.positions;
      totalHeight = computed.totalHeight;

      if (!isInitialConnectPhase && !seriesReadOnly) {
        // Für "fix" gemerkt (siehe handleFixClick) -- die zuletzt
        // TATSÄCHLICH gerenderte Anordnung, nicht dort neu berechnet (ein
        // erneuter computeSeriesLayout-Aufruf würfelt anders und würde nicht
        // mehr dem entsprechen, was gerade zu sehen war).
        lastSeriesRender = { containerWidth: width, totalHeight, positions };
      }
    }

    displayImages.forEach((img, i) => {
      const el = document.createElement('img');
      el.className = 'push-image';
      el.dataset.imageId = img.id;
      el.loading = 'lazy';
      el.decoding = 'async';
      el.src = img.url;
      const pos = positions.get(img.id);
      el.style.width = pos.width + 'px';
      el.style.height = pos.height + 'px';
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';

      if (seriesReadOnly) {
        // Schreibgeschützte, gespeicherte Reihe: Klick entfernt hier nichts
        // (das gibt es nur im Bau-Modus), sondern öffnet die normale
        // Einzelansicht dieses Bildes -- wie jedes andere Bild der Seite.
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => open(img.id));
      } else if (isInitialConnectPhase) {
        // Vor der allerersten Verbindung: Klick auf die Basis (links)
        // promotet einen evtl. gewählten Kandidaten dorthin, Klick auf den
        // Kandidaten (rechts) verwirft ihn -- beide Male zeigt die rechte
        // Spalte danach wieder die Auswahl-Galerie. Ohne gewählten
        // Kandidaten (nur das einzelne Basisbild) gibt es noch nichts zum
        // Anklicken.
        if (pendingCandidate) {
          el.style.cursor = 'pointer';
          el.addEventListener('click', () => (i === 0 ? promotePendingCandidate() : discardPendingCandidate()));
        } else {
          el.style.cursor = 'default';
        }
      } else {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => removeFromSeries(i));
      }
      seriesStage.appendChild(el);
    });

    seriesStage.style.minHeight = totalHeight + 'px';
  }

  // "g"/"create gallery" nur im Bau-Modus (nicht während der Vorschau vor der
  // allerersten Verbindung, nicht in der schreibgeschützten Ansicht) und
  // erst ab einer Reihenlänge von mindestens 3 Bildern -- ein Diptychon
  // (genau 2 Bilder, direkt nach dem Connect) ist noch keine "Reihe" und
  // lässt sich nicht fixieren, erst ab dem dritten (über den Pool
  // hinzugefügten) Bild wird daraus eine fixierbare Reihe.
  function updateFixVisibility() {
    seriesFixEl.style.display = (!pendingCandidate && !seriesReadOnly && seriesIds.length >= 3) ? 'block' : 'none';
  }

  // "r" (zufällig durch die vorhandenen, gespeicherten Reihen browsen,
  // siehe showRandomSeries) -- nur in der schreibgeschützten Ansicht einer
  // bereits gespeicherten Reihe.
  function updateSeriesRandomVisibility() {
    seriesRandomEl.style.display = seriesReadOnly ? 'block' : 'none';
  }

  // "push" (öffnet die Datei-Auswahl, siehe main.js) -- nur in der
  // schreibgeschützten Ansicht einer bereits gespeicherten Reihe, NICHT
  // während einer aktiven Aktion (Connect-Auswahl vor der ersten
  // Verbindung, Bau-Modus einer noch nicht gespeicherten Reihe).
  function updateSeriesPushVisibility() {
    seriesPushEl.style.display = seriesReadOnly ? 'block' : 'none';
  }

  // "s"/"a" -- wie auf der Hauptgalerie: "s" immer verfügbar (mischt bei
  // jedem Klick neu), "a" nur sichtbar, solange NICHT bereits chronologisch
  // (gleiche Regel wie dort). Nur im echten Bau-Modus (baseConnectionIds
  // gesetzt) -- nie vor der allerersten Verbindung (dort gibt es noch keine
  // "Reihenfolge mehrerer Bilder" zum Mischen) oder in einer
  // schreibgeschützten Reihe (dort ist die Anordnung endgültig fixiert).
  function updateSeriesSortVisibility() {
    const buildMode = !pendingCandidate && !seriesReadOnly && baseConnectionIds !== null;
    seriesSEl.style.display = buildMode ? 'block' : 'none';
    seriesAEl.style.display = (buildMode && seriesSortMode === 'random') ? 'block' : 'none';
  }

  function updateSeriesWordsVisibility() {
    seriesConfirmWord.style.display = pendingCandidate ? 'block' : 'none';
    updateFixVisibility();
    updateSeriesRandomVisibility();
    updateSeriesPushVisibility();
    updateSeriesSortVisibility();
  }

  // Mischt die REIHENFOLGE der Bilder selbst (nicht nur ihre Anzeige-
  // Position wie beim Shuffle der Hauptgalerie) -- die Reihenfolge ist hier
  // ja der eigentliche Inhalt der Reihe (wird beim Fixieren 1:1 gespeichert,
  // siehe handleFixClick). Setzt eine bereits "scharf" gestellte
  // "fix"-Bestätigung zurück, wie jede andere Änderung an der Reihe.
  function shuffleSeries() {
    if (pendingCandidate || seriesReadOnly || baseConnectionIds === null) return;
    const shuffled = [...seriesImages];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    seriesImages = shuffled;
    seriesIds = shuffled.map((img) => img.id);
    seriesSortMode = 'random';
    disarmFix();
    renderSeriesView();
    positionSeriesWords();
  }

  // Ordnet zurück in der Reihenfolge, in der die Bilder der Reihe
  // hinzugefügt wurden (seriesAddOrderIds) -- NICHT nach dem created_at der
  // Bilder selbst (anders als die gleichnamige Sortierung der Hauptgalerie,
  // wo es keine "Hinzufüge-Reihenfolge" jenseits des Upload-Datums gibt).
  // No-op, falls bereits so angeordnet.
  function arrangeSeriesOrder() {
    if (pendingCandidate || seriesReadOnly || baseConnectionIds === null || seriesSortMode === 'chronological') return;
    const byId = new Map(seriesImages.map((img) => [img.id, img]));
    seriesIds = [...seriesAddOrderIds];
    seriesImages = seriesIds.map((id) => byId.get(id));
    seriesSortMode = 'chronological';
    disarmFix();
    renderSeriesView();
    positionSeriesWords();
  }

  seriesSEl.addEventListener('click', shuffleSeries);
  seriesAEl.addEventListener('click', arrangeSeriesOrder);

  // Pool: Vereinigung aller Verbindungen ALLER aktuell in der Reihe
  // enthaltenen Bilder (nicht nur des zuletzt hinzugefügten), abzüglich
  // bereits enthaltener Bilder -- live abgeleitet, kein eigener Zustand.
  // Klick übernimmt eine bereits bestehende Kante OHNE createConnection().
  // Gleiche Größe/Anordnung wie die verbundenen Bilder unter der normalen
  // Einzelansicht (siehe renderImageCluster).
  function loadPool() {
    seriesCandidates.innerHTML = '';
    const myGeneration = openGeneration;
    fetchPoolForImages(seriesIds).then((pool) => {
      if (myGeneration !== openGeneration) return; // überholt, siehe open()
      renderImageCluster(seriesCandidates, pool, (img) => addFromPool(img));
    });
  }

  // Pool nur sichtbar im eigentlichen Bau-Modus (baseConnectionIds gesetzt)
  // -- ausgeblendet vor der allerersten Verbindung (dort zeigt die rechte
  // Spalte stattdessen die Auswahl-Galerie, siehe updatePickerVisibility),
  // in einer schreibgeschützten Reihe, UND während "fix" scharf gestellt
  // ist (siehe armFix/disarmFix unten): das ist dann eine reine
  // Kontroll-Ansicht der Reihe vor dem Speichern, kein weiteres Bearbeiten
  // über den Pool mehr möglich.
  function updatePoolVisibility() {
    if (pendingCandidate || seriesReadOnly || fixArmed || baseConnectionIds === null) {
      seriesCandidates.innerHTML = '';
    } else {
      loadPool();
    }
  }

  // Zeichnet die aktuelle Reihe + rechte Spalte/Bedienelemente neu -- OHNE
  // die Route anzufassen: Entfernen/Hinzufügen über den Pool ändert weder
  // die URL noch erzeugt es einen History-Eintrag (siehe Kommentar bei
  // baseConnectionIds oben) -- reiner Client-/Sitzungszustand, geht beim
  // Neuladen verloren. Rechte Spalte zeigt vor der allerersten Verbindung
  // die Auswahl-Galerie (updatePickerVisibility), danach den Pool
  // (updatePoolVisibility) -- nie beide gleichzeitig.
  function renderSeriesView() {
    renderSeriesStage();
    updateSeriesWordsVisibility();
    if (baseConnectionIds === null && !seriesReadOnly) {
      // Pool (#connect-series-candidates) gehört ausschließlich zum echten
      // Bau-Modus (siehe updatePoolVisibility) -- hier explizit leeren, sonst
      // bliebe ein Rest aus einer VORHERIGEN Bau-Sitzung sichtbar stehen und
      // würde sich mit der Auswahl-Galerie rechts überlagern.
      seriesCandidates.innerHTML = '';
      updatePickerVisibility();
    } else {
      updatePoolVisibility();
    }
  }

  // Fügt ein Bild aus dem Pool zur Reihe hinzu -- kein neuer DB-Eintrag
  // (die Verbindung besteht ja bereits), nur die lokale Zusammenstellung
  // wächst. Setzt eine bereits "scharf" gestellte "fix"-Bestätigung zurück
  // (siehe disarmFix) -- eine Änderung an der Reihe soll erneut bestätigt
  // werden müssen, bevor gespeichert wird.
  function addFromPool(img) {
    seriesIds = [...seriesIds, img.id];
    seriesImages = [...seriesImages, img];
    // Zählt immer als zuletzt hinzugefügt in der echten Add-Reihenfolge,
    // unabhängig davon, ob die aktuelle Anzeige (seriesIds) gerade gemischt
    // ist -- siehe seriesAddOrderIds oben.
    seriesAddOrderIds = [...seriesAddOrderIds, img.id];
    disarmFix();
    renderSeriesView();
    positionSeriesWords();
  }

  // Entfernt GENAU dieses eine Bild aus der Reihe (kein Kaskadenlöschen,
  // keine zugrundeliegende Verbindung wird gelöscht) -- alle anderen Bilder
  // bleiben unverändert stehen und rücken auf. Das entfernte Bild taucht
  // danach automatisch wieder im Pool auf (der berechnet sich ja live neu).
  // Mindestens ein Bild bleibt immer stehen -- eine leere Reihe wäre kein
  // sinnvoller Anzeigezustand.
  function removeFromSeries(index) {
    if (seriesReadOnly || seriesIds.length <= 1) return;
    const removedId = seriesIds[index];
    seriesIds = seriesIds.filter((_, i) => i !== index);
    seriesImages = seriesImages.filter((_, i) => i !== index);
    // Per ID statt Index entfernen -- die Position innerhalb der echten
    // Add-Reihenfolge kann von der (evtl. gemischten) Anzeige-Reihenfolge
    // abweichen, siehe seriesAddOrderIds oben.
    seriesAddOrderIds = seriesAddOrderIds.filter((id) => id !== removedId);
    disarmFix();

    // Bleibt nur noch ein einziges Bild übrig, ist die Reihen-Ansicht kein
    // sinnvoller Anzeigezustand mehr (kein Diptychon, keine Reihe) -- statt
    // eine "Reihe" aus einem Bild zu zeigen, geht es direkt zur normalen
    // Einzelansicht dieses letzten Bildes über.
    if (seriesIds.length === 1) {
      const remaining = seriesImages[0];
      seriesIds = [];
      seriesImages = [];
      seriesAddOrderIds = [];
      baseConnectionIds = null;
      open(remaining.id);
      return;
    }

    renderSeriesView();
    positionSeriesWords();
  }

  // Betritt den Bau-Modus einer Reihe über ihre permanente Basis-Verbindung
  // -- gemeinsamer Einstiegspunkt für: Klick auf ein verbundenes Bild in der
  // normalen Einzelansicht (openSeriesFromPair), die allererste bestätigte
  // Verbindung (confirmSeriesConnect) und einen Direktaufruf/popstate der
  // /connect/:idA,:idB-Route (openSeriesFromRoute). pushRoute() setzt hier
  // bewusst UNBEDINGT: während eines stillen Popstate-/Direktaufrufs (siehe
  // router.js/runSilently) unterdrückt pushRoute() selbst jede tatsächliche
  // History-Änderung und aktualisiert nur den Titel -- bei einem echten
  // Klick erzeugt es dagegen korrekt einen neuen Eintrag.
  function enterSeriesBuildMode(idA, idB) {
    baseConnectionIds = [idA, idB];
    seriesReadOnly = false;
    fixArmed = false;
    clearTimeout(fixArmTimer);
    fixArmTimer = null;
    seriesSortMode = 'chronological';
    lastSeriesRender = null;
    seriesSavedLayout = null;
    // Echte Hinzufüge-Reihenfolge beginnt hier -- der Aufrufer hat seriesIds
    // bereits gesetzt (Basis-Paar), siehe openSeriesFromPair/
    // openSeriesFromRoute/confirmSeriesConnect.
    seriesAddOrderIds = [...seriesIds];
    seriesFixEl.textContent = 'g';

    openGeneration += 1;
    overlay.style.display = 'none';
    seriesOverlay.style.display = 'block';
    seriesOverlay.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    setClockVisible(true);

    pushRoute(connectPath(idA, idB), 'push v.r.p. — connect');
    // Erst rendern, dann positionieren -- positionSeriesWords() meidet
    // bereits platzierte Bilder (siehe dort), braucht die Bilder also schon
    // im DOM.
    renderSeriesView();
    positionSeriesWords();
  }

  // Klick auf ein verbundenes Bild unter einem Bild in der normalen
  // Einzelansicht (siehe renderConnectedImages oben) -- öffnet den Bau-Modus
  // für genau diese (bereits bestehende) Kante, als eigener Schritt im
  // Browser-Verlauf.
  function openSeriesFromPair(sourceImg, targetImg) {
    close();
    seriesIds = [sourceImg.id, targetImg.id];
    seriesImages = [sourceImg, targetImg];
    pendingCandidate = null;
    enterSeriesBuildMode(sourceImg.id, targetImg.id);
  }

  // Direktaufruf/Popstate der /connect/:idA,:idB-Route (main.js) -- löst
  // beide IDs zu Bildobjekten auf (nicht notwendigerweise in getImages()
  // enthalten, z.B. bei einem geteilten Link). Schlägt eine Auflösung fehl,
  // wird zur Startseite zurückgekehrt.
  async function openSeriesFromRoute(idA, idB) {
    const images = getImages();
    const resolveOne = async (id) => images.find((i) => i.id === id) || fetchImageById(id);
    const [imgA, imgB] = await Promise.all([resolveOne(idA), resolveOne(idB)]);
    if (!imgA || !imgB) {
      flashMessage('error: could not load this connection');
      goBack();
      return;
    }
    seriesIds = [imgA.id, imgB.id];
    seriesImages = [imgA, imgB];
    pendingCandidate = null;
    enterSeriesBuildMode(imgA.id, imgB.id);
  }

  // Öffnet eine bereits gespeicherte, schreibgeschützte Reihe -- sowohl für
  // einen Klick auf ihren Eintrag in der Hauptgalerie als auch für einen
  // Direktaufruf/popstate der /series/:id-Route (main.js). pushRoute()
  // unbedingt, siehe Kommentar bei enterSeriesBuildMode oben.
  async function openSavedSeries(id) {
    // Nur ein frischer Einstieg (aus main oder per Direktaufruf) bekommt eine
    // neue zufällige Anordnung der Textelemente -- wechselt man dagegen
    // zwischen bereits gespeicherten Reihen (per [r], siehe
    // showRandomSeries), bleiben sie stabil stehen, genau wie [r] in der
    // normalen Einzelansicht (siehe open()/wasAlreadyOpen dort). Muss VOR
    // jeder Zustandsänderung erfasst werden.
    const wasAlreadyOpen = seriesReadOnly && seriesOverlay.style.display === 'block';

    const result = await fetchSeriesById(id);
    if (!result) {
      flashMessage('error: could not load this gallery');
      goBack();
      return;
    }

    openGeneration += 1;
    overlay.style.display = 'none';

    seriesIds = result.images.map((img) => img.id);
    seriesImages = result.images;
    pendingCandidate = null;
    baseConnectionIds = null;
    seriesReadOnly = true;
    fixArmed = false;
    // Eingefrorene Anordnung vom Fixier-Zeitpunkt (siehe handleFixClick) --
    // null bei einer vor Einführung dieses Felds gespeicherten Reihe, dann
    // Fallback auf die normale, live berechnete Anordnung (siehe
    // renderSeriesStage).
    seriesSavedLayout = result.layout || null;

    seriesOverlay.style.display = 'block';
    seriesOverlay.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    setClockVisible(true);

    pushRoute(seriesPath(id), 'push v.r.p. — series');
    // Erst rendern, dann positionieren -- siehe Kommentar in
    // enterSeriesBuildMode.
    renderSeriesView();
    if (wasAlreadyOpen) {
      correctSeriesWordsForImages();
    } else {
      positionSeriesWords();
    }
  }

  // "r" in der schreibgeschützten Ansicht einer gespeicherten Reihe --
  // browst zufällig durch alle vorhandenen Reihen, derselbe Mechanismus wie
  // showRandom() für einzelne Bilder in der normalen Einzelansicht. Reihen
  // werden nie paginiert nachgeladen (siehe main.js/series-repo.js), die
  // von getImages() gelieferte Teilmenge ist daher immer vollständig -- kein
  // eigener Fetch nötig. Self-guarded gegen seriesReadOnly (nicht nur über
  // die Sichtbarkeit, siehe updateSeriesRandomVisibility), konsistent mit
  // dem übrigen Tastenkürzel-Muster dieser Seite.
  function showRandomSeries() {
    if (!seriesReadOnly) return;
    const allSeries = getImages().filter((img) => img.isSeries);
    if (!allSeries.length) return;
    const pick = allSeries[Math.floor(Math.random() * allSeries.length)];
    openSavedSeries(pick.id);
  }

  seriesRandomEl.addEventListener('click', showRandomSeries);

  seriesEsc.addEventListener('click', () => {
    if (pendingCandidate) {
      // Zurück zur Auswahl-Galerie, um ein anderes Bild zu wählen -- vor
      // der allerersten Verbindung wurde ja noch nichts geschrieben
      // (entspricht einem Klick auf den Kandidaten selbst).
      discardPendingCandidate();
    } else if (seriesReadOnly) {
      // Schreibgeschützte Reihe: IMMER direkt zurück zur Hauptgalerie,
      // nicht nur einen Schritt zurück (goBack()/history.back()) -- "r"
      // (siehe showRandomSeries) kann beim Durchbrowsen mehrerer Reihen
      // einen langen Verlaufs-Stapel aus /series/:id-Einträgen aufbauen;
      // ein einzelnes "z" soll trotzdem immer sofort zu main führen, statt
      // nur zur zuletzt besuchten Reihe zurückzuspringen (Bug: kurzes
      // Aufblitzen von main, dann Rücksprung in die vorherige Reihe).
      close();
      pushRoute(HOME_PATH, HOME_TITLE);
    } else {
      // Auswahl (nur Basisbild, noch kein Kandidat) und Bau-Modus: ein
      // Schritt zurück (i.d.R. zur Einzelansicht, aus der heraus geöffnet
      // wurde).
      close();
      goBack();
    }
  });

  async function confirmSeriesConnect() {
    if (!pendingCandidate) return;
    const candidate = pendingCandidate;
    const sourceId = seriesIds[0];
    // Deaktivieren statt eines separaten isConnecting-Flags: verhindert
    // Doppelklicks zuverlässig und macht den Zustand während der Anfrage
    // sichtbar, ganz ohne zusätzliche Variable.
    seriesConfirmWord.style.pointerEvents = 'none';
    seriesConfirmWord.style.opacity = '0.3';
    try {
      const { error, isDuplicate } = await createConnection(sourceId, candidate.id);
      if (error && !isDuplicate) {
        console.error('Connect fehlgeschlagen:', error);
        flashMessage('error: could not connect');
        return; // pendingCandidate bleibt bestehen, erneuter Versuch möglich
      }
      if (isDuplicate) {
        flashMessage('error: already connected');
      } else {
        markConnectCooldown();
        flashMessage('images connected');
      }
      // Zurück zur Einzelansicht des zuerst gewählten Bildes (nicht des
      // gerade verbundenen Zielbilds, nicht die Reihen-/Diptychon-Ansicht) --
      // die neue Verbindung erscheint dort unter den verbundenen Bildern
      // (fetchConnectedImages in open()) und kann von dort aus wie jede
      // andere bestehende Verbindung per Klick zur Reihen-Ansicht geöffnet
      // werden (siehe openSeriesFromPair).
      pendingCandidate = null;
      seriesIds = [];
      seriesImages = [];
      seriesAddOrderIds = [];
      open(sourceId);
    } finally {
      seriesConfirmWord.style.pointerEvents = 'auto';
      seriesConfirmWord.style.opacity = '1';
    }
  }

  seriesConfirmWord.addEventListener('click', confirmSeriesConnect);

  // Wie lange "create gallery" scharf bleibt, bevor es sich von selbst
  // wieder auf "g" zurücksetzt (siehe disarmFix) -- eine vergessene, scharf
  // gestellte Bestätigung soll nicht unbegrenzt stehen bleiben.
  const FIX_ARM_TIMEOUT_MS = 8000;

  // Stellt "create gallery" scharf: Pool wird ausgeblendet (siehe
  // updatePoolVisibility) -- eine reine Kontroll-Ansicht der fertigen Reihe
  // vor dem Speichern, kein weiteres Bearbeiten über den Pool mehr möglich.
  // Setzt sich nach FIX_ARM_TIMEOUT_MS von selbst zurück, falls nicht vorher
  // bestätigt wird.
  function armFix() {
    fixArmed = true;
    seriesFixEl.textContent = 'create gallery';
    clearTimeout(fixArmTimer);
    fixArmTimer = setTimeout(disarmFix, FIX_ARM_TIMEOUT_MS);
    updatePoolVisibility();
  }

  // Setzt eine scharf gestellte "create gallery"-Bestätigung zurück -- durch
  // Zeitablauf, oder weil sich an der Reihe etwas geändert hat (Pool-
  // Hinzufügen/Entfernen, Shuffle/Order, siehe die jeweiligen
  // Aufrufstellen): das Speichern muss dann mit einem frischen "g"-Klick neu
  // begonnen werden. No-op, falls ohnehin nicht scharf -- macht den Aufruf
  // an jeder Änderungsstelle bedenkenlos möglich, ohne den Pool dort
  // unnötig doppelt neu zu laden (renderSeriesView() lädt ihn ohnehin schon).
  function disarmFix() {
    if (!fixArmed) return;
    fixArmed = false;
    seriesFixEl.textContent = 'g';
    clearTimeout(fixArmTimer);
    fixArmTimer = null;
    updatePoolVisibility();
  }

  // Zweistufig: erster Klick verwandelt "g" an derselben Stelle (keine
  // Neupositionierung) in das ausgeschriebene "create gallery", erst ein
  // zweiter Klick führt die eigentliche Speicherung aus. Self-guarded gegen
  // den Zustand (nicht nur über die Sichtbarkeit, siehe updateFixVisibility)
  // -- konsistent mit dem übrigen Tastenkürzel-Muster dieser Seite.
  async function handleFixClick() {
    if (pendingCandidate || seriesReadOnly || seriesIds.length < 3) return;
    if (!fixArmed) {
      armFix();
      return;
    }
    clearTimeout(fixArmTimer);
    fixArmTimer = null;

    seriesFixEl.style.pointerEvents = 'none';
    seriesFixEl.style.opacity = '0.3';
    try {
      // Die zuletzt tatsächlich gerenderte Anordnung (siehe
      // renderSeriesStage) wird 1:1 eingefroren -- wie bei einem Screenshot,
      // inklusive der Fensterbreite, bei der sie berechnet wurde (für die
      // proportionale Skalierung beim späteren Anzeigen, siehe dort).
      const layout = lastSeriesRender ? {
        containerWidth: lastSeriesRender.containerWidth,
        totalHeight: lastSeriesRender.totalHeight,
        positions: seriesIds.map((imgId) => {
          const pos = lastSeriesRender.positions.get(imgId);
          return {
            id: imgId, left: pos.left, top: pos.top, width: pos.width, height: pos.height,
          };
        }),
      } : null;
      const { error, id } = await createSeries(seriesIds, layout);
      if (error) {
        flashMessage('error: could not save gallery');
        disarmFix(); // setzt Text zurück UND zeigt den Pool wieder
        return;
      }
      // Zurück zur Hauptgalerie statt zur schreibgeschützten Reihen-Ansicht --
      // die frisch gespeicherte Reihe erscheint dort wie ein gerade
      // gepushtes Bild (siehe gallery.js addSeries), nicht als eigener
      // Navigationsschritt.
      const savedFirstImage = seriesImages[0];
      const savedCount = seriesIds.length;
      close();
      pushRoute(HOME_PATH, HOME_TITLE);
      flashMessage('gallery fixed');
      onSeriesSaved({
        id,
        url: savedFirstImage.url,
        width: savedFirstImage.width,
        height: savedFirstImage.height,
        count: savedCount,
        isSeries: true,
      });
    } finally {
      seriesFixEl.style.pointerEvents = 'auto';
      seriesFixEl.style.opacity = '1';
    }
  }

  seriesFixEl.addEventListener('click', handleFixClick);

  // [c] und Enter lösen in der Vorschau vor der allerersten Verbindung
  // dieselbe Aktion aus wie der Klick auf "connect" -- ausschließlich,
  // während ein pendingCandidate zur Bestätigung ansteht; in der normalen
  // Einzelansicht bleibt [c] der Auslöser für das Öffnen des Auswahl-Modus
  // (siehe main.js, das [c] dort zentral auf connectBtn umleitet). [Enter]
  // löst zusätzlich die zweite Stufe von "fix" aus (das eigentliche
  // Speichern), sobald diese scharf gestellt ist. Am document statt an
  // einem Overlay-Element registriert, da Tasten-Events am jeweils
  // fokussierten Element (i.d.R. <body>) ausgelöst werden und nicht in ein
  // unfokussiertes div hinein bubbeln würden.
  document.addEventListener('keydown', (e) => {
    if (seriesOverlay.style.display !== 'block') return;
    if (pendingCandidate && (e.key === 'c' || e.key === 'C' || e.key === 'Enter')) {
      e.preventDefault();
      confirmSeriesConnect();
    } else if (!pendingCandidate && fixArmed && e.key === 'Enter') {
      e.preventDefault();
      handleFixClick();
    }
  });

  // [g] braucht hier KEINEN eigenen keydown-Listener: main.js leitet die
  // Taste bereits per .click() auf seriesFixEl um (wie bei "a"/"s", siehe
  // dort) -- ein zusätzlicher direkter Listener hier würde handleFixClick
  // bei einem einzigen Tastendruck ZWEIMAL auslösen (einmal direkt, einmal
  // über den weitergeleiteten Klick) und damit die zweistufige
  // "g"->"create gallery" Bestätigung in einen einzigen Tastendruck
  // kollabieren lassen. [Enter] ist davon nicht betroffen (main.js leitet
  // nur "g" weiter, keine andere Taste), daher oben direkt als zweite
  // Bestätigung verdrahtet.

  return {
    open,
    // Für das Routing (main.js): schließt Einzelansicht UND Reihen-Ansicht
    // (inkl. eines evtl. offenen Auswahl-Zwischenschritts), ohne die
    // goBack()-Logik der jeweiligen esc-Klicks auszulösen — genutzt, wenn
    // eine andere Route bereits von außen vorgibt, dass hier zu schließen ist.
    close,
    showRandom,
    // Für main.js: Direktaufruf/popstate der /connect/:idA,:idB- bzw.
    // /series/:id-Route.
    openSeriesFromRoute,
    openSavedSeries,
    // Für main.js: unterscheidet beim "p"-Tastenkürzel zwischen einer
    // schreibgeschützten Gallery-Ansicht (dort erlaubt) und einer aktiven
    // Aktion (Connect-Auswahl, Reihe bauen -- dort weiterhin gesperrt).
    isSeriesReadOnly: () => seriesReadOnly,
    // Für Fenstergrößenänderungen: prüft selbst, welche der beiden Ansichten
    // (Einzelansicht, connect-Reihe) gerade offen ist.
    reposition: () => {
      if (overlay.style.display === 'block') positionActionWords();
      if (seriesOverlay.style.display === 'block') {
        renderSeriesStage();
        positionSeriesWords();
        // Auswahl-Galerie (vor der allerersten Verbindung, noch kein
        // Kandidat gewählt) neu anordnen -- andere Spaltenbreite.
        if (baseConnectionIds === null && !seriesReadOnly && !pendingCandidate) {
          loadConnectPicker();
        }
      }
    },
  };
}

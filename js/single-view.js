import { fetchImageById, fetchAllImages } from './images-repo.js';
import { createConnection, fetchConnectedImages } from './connections-repo.js';
import { createGallery } from './gallery.js';
import { computeChronologicalLayout, EDGE_MARGIN } from './layout-engine.js';
import { randomSpot, clampToViewport, clampFromRect, computeContainRect } from './position-utils.js';
import { repositionClock, setClockVisible } from './clock.js';
import { pushRoute, replaceRoute, goBack, imagePath } from './router.js';
import { flashMessage } from './feedback.js';

// Sicherheitsabstand der frei platzierten Textelemente zur Bildfläche
// bzw. zum Bildschirmrand — großzügiger als der allgemeine Default,
// damit in der Einzelansicht nichts ins Bild hineinragt.
const IMAGE_SAFETY_PAD = 40;
const EDGE_SAFETY_PAD = 32;

// "connect": geräte-/sitzungsbasierte Abklingzeit (localStorage, unabhängig
// vom jeweiligen Bild) -- innerhalb der 10s bleibt "c" ausgeblendet.
const CONNECT_COOLDOWN_MS = 10000;
const CONNECT_COOLDOWN_KEY = 'push_connect_last';

function connectCooldownRemaining() {
  const last = parseInt(localStorage.getItem(CONNECT_COOLDOWN_KEY) || '0', 10);
  return Math.max(0, CONNECT_COOLDOWN_MS - (Date.now() - last));
}

function markConnectCooldown() {
  localStorage.setItem(CONNECT_COOLDOWN_KEY, String(Date.now()));
}

function unionRect(a, b) {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
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

// Reservierte Fläche oben links in der connect-Auswahlgalerie (siehe
// layout-engine.js) -- größer als das Standard-Konsolenmaß, da hier
// zusätzlich zum "connect"-Wort noch eine Vorschau des Ausgangsbildes sitzt
// (siehe #connect-select-preview in style.css, dessen Größe/Position hierzu
// passen muss).
const CONNECT_SELECT_RESERVED = { width: 180, height: 220 };

export function initSingleView(refs, getImages, getSortMode) {
  const {
    overlay, imageEl, escBtn, randomBtn, connectBtn, connectionsStage,
    selectOverlay, selectStage, selectEsc, selectA, selectS, selectPreview,
    confirmOverlay, confirmImageA, confirmImageB, confirmWord, confirmEsc,
  } = refs;

  let currentImage = null;
  let currentImageRect = null;
  let currentContextImages = null; // welche Liste "r" gerade durchsucht

  // Erhöht sich bei jedem open()/close() — eine open()-Anfrage, die während
  // des Preloads (siehe preloadImage oben) oder des asynchronen Nachladens
  // der verbundenen Bilder durch eine neuere Anfrage oder ein zwischen-
  // zeitliches close() überholt wurde, erkennt das daran und wendet ihr
  // (dann veraltetes) Ergebnis nicht mehr an.
  let openGeneration = 0;

  let connectCooldownTimer = null;
  let connectSourceImage = null; // Ausgangsbild des gerade laufenden connect-Vorgangs
  let connectTargetImage = null; // in Schritt 3 gewähltes Bild
  let isConnecting = false;
  let selectGallery = null; // Galerie-Instanz des Auswahl-Modus (Schritt 3)

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
    [escBtn, randomBtn, connectBtn].forEach(correctElementForImage);
    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
  }

  function positionActionWords() {
    const taken = [];
    [escBtn, randomBtn, connectBtn].forEach((el) => {
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
  // Anordnung wie die Hauptgalerie), aber ohne Shuffle-Möglichkeit -- die
  // übergebene Liste ist bereits älteste-Verbindung-zuerst sortiert (siehe
  // connections-repo.js), computeChronologicalLayout verarbeitet sie einfach
  // in der gegebenen Reihenfolge.
  function renderConnectedImages(images) {
    clearConnectionsStage();
    if (!images.length) return;

    const width = connectionsStage.clientWidth || window.innerWidth;
    const { positions, heightmap } = computeChronologicalLayout(images, width);
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
      // Volle Einzelansicht des verbundenen Bildes -- keine Einschränkung
      // der weiteren Navigation (eigenes [c], eigene verbundenen Bilder).
      el.addEventListener('click', () => open(img.id));
      connectionsStage.appendChild(el);
    });
    connectionsStage.style.minHeight = (Math.max(...heightmap) + EDGE_MARGIN) + 'px';
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
    // Klick auf ein verbundenes Bild, Rückkehr aus einem connect-Vorgang)
    // aktualisiert nur die URL (Reload/Teilen-Link) per replaceRoute, ohne
    // eigenen History-Eintrag. Dadurch bleibt es bei GENAU einem Eintrag für
    // eine ganze Einzelansicht-"Sitzung", egal wie viele Bilder darin
    // besucht wurden — [z] (goBack()) führt daher immer direkt zurück zur
    // Hauptgalerie, nie zu einem vorherigen Bild einer Kette.
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
      renderConnectedImages(connected);
    });
  }

  function close() {
    openGeneration += 1; // verwirft eine evtl. noch wartende open()-/Verbindungs-Anfrage (siehe oben)
    overlay.style.display = 'none';
    // Bei einem connect-Vorgang ist die Einzelansicht selbst gerade
    // ausgeblendet (isOpen('single-view') liefert also false) — eine externe
    // Navigation weg von der Bildroute (z.B. physischer Zurück-Button, siehe
    // main.js/syncViewToRoute) würde die connect-Ansichten sonst offen und
    // verwaist zurücklassen. Harmlos, falls ohnehin schon geschlossen.
    selectOverlay.style.display = 'none';
    confirmOverlay.style.display = 'none';
    connectSourceImage = null;
    connectTargetImage = null;
    currentImage = null;
    currentImageRect = null;
    currentContextImages = null;
    document.body.style.overflow = '';
  }

  function showRandom() {
    const images = currentContextImages || getImages();
    if (!images.length) return;
    const pick = images[Math.floor(Math.random() * images.length)];
    open(pick.id, null);
  }

  // Echte Nutzeraktion (Klick/Taste) — aktualisiert zusätzlich die URL
  // (siehe router.js).
  escBtn.addEventListener('click', () => {
    close();
    goBack();
  });
  randomBtn.addEventListener('click', showRandom);
  connectBtn.addEventListener('click', () => openConnectSelect());

  // ─────────────────────────────────────────────
  // "connect" — Schritt 3: Auswahl-Modus (Hauptgalerie im aktuellen
  // Sortierzustand, Ausgangsbild ausgeschlossen, Klick führt zu Schritt 4).
  // ─────────────────────────────────────────────

  function positionSelectWords() {
    const taken = [];
    [selectEsc, selectS, selectA].forEach((el) => {
      const spot = randomSpot(taken, { margin: 60 });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
  }

  // "a" (zurück zur chronologischen Ordnung) nur sichtbar, solange der
  // Auswahl-Modus NICHT bereits chronologisch ist -- dieselbe Regel wie auf
  // der Hauptgalerie (siehe main.js), hier aber unabhängig von deren
  // eigenem Sortierzustand, da dies eine eigenständige Galerie-Instanz ist.
  function updateSelectAVisibility(mode) {
    selectA.style.display = mode === 'random' ? 'block' : 'none';
  }

  // Ausgangsbild bleibt in der Liste (nicht ausgeschlossen) -- dient als
  // Scroll-Ankerpunkt (siehe openConnectSelect/confirmEsc unten), ist aber
  // nicht auswählbar: onImageClick ignoriert einen Klick darauf, der Cursor
  // wird auf "default" zurückgesetzt (statt des von gallery.js gesetzten
  // "pointer"), damit es auch optisch nicht wie ein klickbares Bild wirkt.
  //
  // Nutzt bewusst eine eigene, vollständige Abfrage (fetchAllImages, ohne
  // limit/Pagination) statt getImages() (die Hauptgalerie-Liste): die
  // Hauptgalerie lädt nur häppchenweise nach (siehe main.js/maybeLoadMore)
  // -- ohne eigene Abfrage stünden hier nur die bereits gescrollten Bilder
  // zur Auswahl, nicht der vollständige Bestand.
  async function buildSelectGallery() {
    const sourceId = connectSourceImage.id;
    const myGeneration = openGeneration; // siehe open()/close() -- verwirft ein überholtes Ergebnis
    const pool = await fetchAllImages();
    if (myGeneration !== openGeneration) return; // zwischenzeitlich geschlossen/weiternavigiert

    selectPreview.src = connectSourceImage.url;
    selectStage.innerHTML = '';
    selectGallery = createGallery(selectStage, pool, {
      onImageClick: (img) => {
        if (img.id === sourceId) return;
        openConnectConfirm(img);
      },
      initialSortMode: getSortMode(),
      onSortModeChange: updateSelectAVisibility,
      reservedArea: CONNECT_SELECT_RESERVED,
    });
    updateSelectAVisibility(selectGallery.getSortMode());

    const sourceEl = selectGallery.elements.get(sourceId);
    if (sourceEl) {
      sourceEl.style.cursor = 'default';
      sourceEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  async function openConnectSelect() {
    if (!currentImage || connectCooldownRemaining() > 0) return; // doppelte Absicherung zum ausgeblendeten Button
    connectSourceImage = currentImage;
    connectTargetImage = null;
    overlay.style.display = 'none';
    confirmOverlay.style.display = 'none';
    // ERST sichtbar schalten, DANN die Galerie bauen: createGallery() liest
    // beim Layout stageEl.clientWidth aus -- bei einem noch display:none
    // Overlay liefert das 0 (Fallback auf 680px), die Galerie füllte dadurch
    // sichtbar nur einen Bruchteil der tatsächlichen Fensterbreite.
    selectOverlay.style.display = 'block';
    selectStage.innerHTML = ''; // alten Inhalt sofort weg, während neu geladen wird
    positionSelectWords();
    await buildSelectGallery();
  }

  selectEsc.addEventListener('click', () => {
    // Abbruch von Schritt 3: zurück zur ursprünglichen Einzelansicht, ohne
    // dass etwas verbunden wird.
    selectOverlay.style.display = 'none';
    open(connectSourceImage.id);
  });
  // [a]/[s] wirken ausschließlich auf diese eigenständige Auswahl-Galerie,
  // nie auf die Hauptgalerie dahinter (siehe createGallery-Aufruf oben).
  selectA.addEventListener('click', () => { if (selectGallery) selectGallery.sortChronological(); });
  selectS.addEventListener('click', () => { if (selectGallery) selectGallery.shuffleRandom(); });

  // ─────────────────────────────────────────────
  // "connect" — Schritt 4: Bestätigungsansicht (beide Bilder nebeneinander).
  // ─────────────────────────────────────────────

  function positionConfirmWords() {
    const rectA = confirmImageA.getBoundingClientRect();
    const rectB = confirmImageB.getBoundingClientRect();
    const avoidRect = unionRect(rectA, rectB);
    const spot = randomSpot([], { margin: 60, avoidRect });
    confirmEsc.style.left = spot.x + 'px';
    confirmEsc.style.top = spot.y + 'px';
    clampFromRect(confirmEsc, avoidRect, 24);
    clampToViewport(confirmEsc);
  }

  function openConnectConfirm(targetImg) {
    connectTargetImage = targetImg;
    selectOverlay.style.display = 'none';
    confirmImageA.src = connectSourceImage.url;
    confirmImageB.src = targetImg.url;
    confirmOverlay.style.display = 'block';
    // Erst nach dem Sichtbar-Schalten messbar (getBoundingClientRect).
    requestAnimationFrame(positionConfirmWords);
  }

  confirmEsc.addEventListener('click', () => {
    // Abbruch von Schritt 4: zurück zu Schritt 3 (Auswahl-Modus), ohne dass
    // etwas verbunden wird. Reihenfolge wie in openConnectSelect() (erst
    // sichtbar schalten, dann bauen) -- siehe dortiger Kommentar.
    confirmOverlay.style.display = 'none';
    selectOverlay.style.display = 'block';
    selectStage.innerHTML = '';
    positionSelectWords();
    buildSelectGallery();
  });

  // ─────────────────────────────────────────────
  // "connect" — Schritt 5: Verbindung herstellen.
  // ─────────────────────────────────────────────

  async function confirmConnect() {
    if (isConnecting || !connectSourceImage || !connectTargetImage) return;
    isConnecting = true;
    const sourceId = connectSourceImage.id;
    try {
      const { error, isDuplicate } = await createConnection(connectSourceImage.id, connectTargetImage.id);
      if (error && !isDuplicate) {
        console.error('Connect fehlgeschlagen:', error);
        flashMessage('error: could not connect');
        return; // auf der Bestätigungsseite bleiben, damit erneut versucht werden kann
      }
      if (isDuplicate) {
        flashMessage('already connected');
      } else {
        markConnectCooldown();
      }
      confirmOverlay.style.display = 'none';
      connectSourceImage = null;
      connectTargetImage = null;
      await open(sourceId);
    } finally {
      isConnecting = false;
    }
  }

  confirmWord.addEventListener('click', confirmConnect);

  // [c] und Enter lösen in der Bestätigungsansicht dieselbe Aktion aus wie
  // der Klick auf "connect" -- ausschließlich, während sie aktiv ist; in der
  // normalen Einzelansicht bleibt [c] der Auslöser für das Öffnen des
  // Auswahl-Modus (siehe main.js, das [c] dort zentral auf connectBtn
  // umleitet). Am document statt am Overlay selbst registriert, da Tasten-
  // Events am jeweils fokussierten Element (i.d.R. <body>) ausgelöst werden
  // und nicht in ein unfokussiertes div hinein bubbeln würden.
  document.addEventListener('keydown', (e) => {
    if (confirmOverlay.style.display !== 'block') return;
    if (e.key === 'c' || e.key === 'C' || e.key === 'Enter') {
      e.preventDefault();
      confirmConnect();
    }
  });

  return {
    open,
    // Für das Routing (main.js): Ansicht schließen, ohne die goBack()-Logik
    // des escBtn-Klicks auszulösen — genutzt, wenn eine andere Route bereits
    // von außen vorgibt, dass diese Ansicht zu schließen ist.
    close,
    showRandom,
    connect: openConnectSelect,
    // Für Fenstergrößenänderungen: nur die frei positionierten Textelemente
    // zurück in den sichtbaren Bereich holen — das Bild behält seine
    // ursprüngliche Größe (wird nicht neu berechnet, soll nicht schrumpfen).
    reposition: () => {
      if (overlay.style.display === 'block') positionActionWords();
      if (selectOverlay.style.display === 'block') {
        positionSelectWords();
        if (selectGallery) selectGallery.relayout();
      }
      if (confirmOverlay.style.display === 'block') positionConfirmWords();
    },
    isSelectOpen: () => selectOverlay.style.display === 'block',
    isConfirmOpen: () => confirmOverlay.style.display === 'block',
  };
}

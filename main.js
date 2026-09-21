import { fetchImages } from './images-repo.js';
import {
  fetchConnectGalleries, createConnectGallery, toConnectGalleryPreviewItem,
} from './connect-repo.js';
import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';
import { createGallery } from './gallery.js';
import { initUpload } from './upload.js';
import { initDragDrop } from './drag-drop.js';
import { initSingleView } from './single-view.js';
import { initConnectView } from './connect-view.js';
import { initVrp } from './vrp.js';
import { mountClock, setClockVisible } from './clock.js';
import {
  mountNoticeConsole, showRandomHint, showMessage, showStickyMessage, clearStickyMessage,
} from './notice-board.js';
import { flashMessage } from './feedback.js';
import { initHideTextMode } from './star-toggle.js';
import { clampToViewport, clampFromRect, randomSpot as randomSpotUtil } from './position-utils.js';
import { initWelcome } from './welcome.js';
import {
  parseRoute, runSilently, markOpenedFromDirectLoad, pushRoute, HOME_PATH, HOME_TITLE,
} from './router.js';

const stage = document.getElementById('stage');
const menuLayer = document.getElementById('menu-layer');

// connect-Galerien (siehe [c]) sind eine eigene, ungepaginierte Tabelle
// (deutlich seltener als normale Pushes) -- einmal komplett geladen und mit
// jeder nachgeladenen Bilder-Seite (siehe maybeLoadMore unten) chronologisch
// gemischt, statt eine eigene, parallele Pagination dafür nachzubauen.
function mergeByCreatedAt(a, b) {
  return [...a, ...b].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
}

const [initialImages, connectGalleries] = await Promise.all([
  fetchImages({ limit: 60 }),
  fetchConnectGalleries(),
]);
const images = mergeByCreatedAt(initialImages, connectGalleries.map(toConnectGalleryPreviewItem));

// Kleiner Kreisverweis: gallery ruft singleView.open() auf, singleView braucht
// gallery.getImages — beide werden daher über eine verzögerte Referenz verbunden.
// connectView braucht aus demselben Grund ebenfalls eine verzögerte Referenz
// (ihr eigener onImageClick öffnet wiederum singleView).
let singleView;
let connectView;
let upload;

function isOpen(id) {
  return document.getElementById(id).style.display === 'block';
}

// Auswahl-Modus für eine neue connect-Galerie (siehe [c] unten) -- während
// aktiv lenkt ein Bildklick auf toggleConnectSelection() statt auf die
// normalen Öffnen-Aktionen (singleView/connectView).
let connectModeActive = false;
const selectedConnectIds = new Set();

const gallery = createGallery(stage, images, {
  onImageClick: (img) => {
    if (connectModeActive) {
      toggleConnectSelection(img);
    } else if (img.kind === 'connect') {
      connectView.open(img.id);
    } else {
      singleView.open(img.id);
    }
  },
});

// ─────────────────────────────────────────────
// Nachladen beim Scrollen — löst die feste 300er-Grenze durch echtes,
// endloses Nachladen in kleinen Häppchen ab. Cursor bezieht sich bewusst nur
// auf die (paginierte) Bilder-Tabelle -- connect-Galerien sind bereits
// vollständig geladen (siehe oben).
// ─────────────────────────────────────────────
let oldestLoadedAt = initialImages.length ? initialImages[initialImages.length - 1].createdAt : null;
let loadingMore = false;
let noMoreImages = initialImages.length < 60;

async function maybeLoadMore() {
  if (loadingMore || noMoreImages || !oldestLoadedAt) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 1000;
  if (!nearBottom) return;

  loadingMore = true;
  const nextBatch = await fetchImages({ limit: 60, before: oldestLoadedAt });
  if (nextBatch.length) {
    gallery.appendImages(nextBatch);
    oldestLoadedAt = nextBatch[nextBatch.length - 1].createdAt;
  }
  if (nextBatch.length < 60) noMoreImages = true;
  loadingMore = false;
}

window.addEventListener('scroll', maybeLoadMore);

// ─────────────────────────────────────────────
// Echtzeit: neu gepushte Bilder von anderen erscheinen live, ohne Neuladen.
// Voraussetzung: Tabelle "images" muss einmalig für Realtime freigegeben sein
// (siehe Hinweis dazu separat).
// ─────────────────────────────────────────────
supabase
  .channel('realtime-images')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'images' }, (payload) => {
    const row = payload.new;
    if (gallery.elements.has(row.id)) return; // eigener, gerade selbst gepushter Eintrag
    const { width, height } = computeDisplaySize(row.natural_width || 1, row.natural_height || 1);
    gallery.prependImages([{
      id: row.id,
      url: row.url,
      width,
      height,
    }]);
  })
  .subscribe();

singleView = initSingleView({
  overlay: document.getElementById('single-view'),
  imageEl: document.getElementById('single-image'),
  escBtn: document.getElementById('single-esc'),
  randomBtn: document.getElementById('single-r'),
  infoViewsEl: document.getElementById('single-info-views'),
  infoPushedEl: document.getElementById('single-info-pushed'),
  infoSizeEl: document.getElementById('single-info-size'),
  infoResolutionEl: document.getElementById('single-info-resolution'),
  countdownEl: document.getElementById('single-countdown'),
  connectPreviewsEl: document.getElementById('single-connect-previews'),
  connectPreviewsStageEl: document.getElementById('single-connect-previews-stage'),
  // connectView wird direkt im Anschluss zugewiesen (siehe unten) -- dieser
  // Callback wird erst bei einem tatsächlichen Klick aufgerufen, also lange
  // danach.
}, gallery.getImages, (id) => connectView.open(id));

// Bilder INNERHALB einer geöffneten connect-Galerie verhalten sich beim
// Klick wie überall sonst: normales single view, mit [r] dort ausschließlich
// unter einzelnen Bildern browsend (unverändert, da fetchRandomImage() in
// images-repo.js von connect_galleries nichts weiß).
connectView = initConnectView({
  overlay: document.getElementById('connect-view'),
  stage: document.getElementById('connect-stage'),
  escBtn: document.getElementById('connect-esc'),
  randomBtn: document.getElementById('connect-r'),
}, (img) => singleView.open(img.id));

// ─────────────────────────────────────────────
// Fixe Menü-Textelemente: bei jedem vollen Laden neu platziert,
// bleiben beim Scrollen an ihrer Position (position: fixed).
// ─────────────────────────────────────────────
const MENU_WORDS = ['push', 'c', 's', 'r', 'i'];
const placed = [];

function randomSpot() {
  const margin = 60;
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = margin + Math.random() * (window.innerWidth - margin * 2);
    const y = margin + Math.random() * (window.innerHeight - margin * 2);
    const farEnough = placed.every((p) => Math.hypot(p.x - x, p.y - y) > 140);
    if (farEnough) return { x, y };
  }
  return { x: margin, y: margin };
}

const menuEls = {};
MENU_WORDS.forEach((word) => {
  const spot = randomSpot();
  placed.push(spot);

  const el = document.createElement('div');
  el.className = 'menu-word';
  el.style.left = spot.x + 'px';
  el.style.top = spot.y + 'px';
  el.textContent = word;

  menuLayer.appendChild(el);
  menuEls[word] = el;
  clampToViewport(el);
});

// ─────────────────────────────────────────────
// Datum/Uhrzeit — eigenes Modul, liegt über allem (auch über Overlays).
// Ein Klick darauf sortiert die Galerie chronologisch (siehe Shortcuts
// unten) -- ersetzt das frühere eigene Textelement "a" dafür.
// ─────────────────────────────────────────────
const clockSpot = randomSpot();
placed.push(clockSpot);
const clockEl = mountClock();
clockEl.style.left = clockSpot.x + 'px';
clockEl.style.top = clockSpot.y + 'px';
clampToViewport(clockEl);

const hideTextMode = initHideTextMode();
mountNoticeConsole();

// ─────────────────────────────────────────────
// v.r.p. — eigenständiges Element, nur auf der Hauptseite, kein Kurzbefehl
// ─────────────────────────────────────────────
const vrp = initVrp({
  overlay: document.getElementById('vrp-view'),
  listLayer: document.getElementById('vrp-list'),
  textLayer: document.getElementById('vrp-text'),
  escBtn: document.getElementById('vrp-esc'),
});

const vrpSpot = randomSpot();
placed.push(vrpSpot);
const vrpEl = document.createElement('div');
vrpEl.className = 'menu-word';
vrpEl.textContent = 'v.r.p.';
vrpEl.style.left = vrpSpot.x + 'px';
vrpEl.style.top = vrpSpot.y + 'px';
menuLayer.appendChild(vrpEl);
clampToViewport(vrpEl);
vrpEl.addEventListener('click', () => vrp.open());
// TEMPORÄR ausgeblendet auf Wunsch -- aktuell noch ohne Inhalt/Nutzen,
// soll an anderer Stelle ausgebaut werden. Rest (Klick-Handler,
// Repositionierung bei Fenstergrößenänderung) bewusst unangetastet, damit
// das Wiedereinblenden später nur das Entfernen dieser einen Zeile braucht.
vrpEl.style.display = 'none';

// Gibt die belegten Positionen zurück (statt sie nur lokal zu verwenden) --
// repositionClockForMain() braucht genau diese FRISCHEN Positionen, um die
// Uhr nicht mit den gerade erst neu gewürfelten Wörtern zu überlagern
// (siehe dort; vorher prüfte die Uhr stattdessen gegen das veraltete,
// äußere "placed"-Array von der allerersten Platzierung beim Seitenaufbau).
function repositionMainMenu() {
  const taken = [];
  MENU_WORDS.forEach((word) => {
    const spot = randomSpotUtil(taken, { margin: 60, minDist: 140 });
    taken.push(spot);
    const el = menuEls[word];
    el.style.left = spot.x + 'px';
    el.style.top = spot.y + 'px';
    clampToViewport(el);
  });
  const vrpSpotNew = randomSpotUtil(taken, { margin: 60, minDist: 140 });
  vrpEl.style.left = vrpSpotNew.x + 'px';
  vrpEl.style.top = vrpSpotNew.y + 'px';
  clampToViewport(vrpEl);
  taken.push(vrpSpotNew);
  return taken;
}

// taken: die frisch belegten Positionen von repositionMainMenu() (siehe
// dort) -- ohne die würde randomSpotUtil() die Uhr blind, ohne Kenntnis der
// gerade erst neu platzierten Wörter, platzieren.
function repositionClockForMain(taken = []) {
  setClockVisible(true);
  const spot = randomSpotUtil(taken, { margin: 60, minDist: 140 });
  clockEl.style.left = spot.x + 'px';
  clockEl.style.top = spot.y + 'px';
  clampToViewport(clockEl);
}
document.getElementById('single-esc').addEventListener('click', () => {
  // [z] soll IMMER direkt zurück zu main führen -- auch wenn dieses Bild
  // INNERHALB einer noch offenen connect-Galerie geöffnet wurde
  // (connectView-Aufbau oben; single-view.js schließt dabei nur sich
  // selbst). Die liegt sonst weiterhin offen darunter, statt main
  // freizugeben -- hier also gleich mitschließen.
  if (isOpen('connect-view')) connectView.close();
  repositionClockForMain(repositionMainMenu());
});
document.getElementById('upload-esc').addEventListener('click', () => { repositionClockForMain(repositionMainMenu()); });
document.getElementById('vrp-esc').addEventListener('click', () => { repositionClockForMain(repositionMainMenu()); });
document.getElementById('connect-esc').addEventListener('click', () => { repositionClockForMain(repositionMainMenu()); });

// ─────────────────────────────────────────────
// connect-Modus ([c]): Auswahl von >=2 Bildern für eine neue connect-Galerie.
// Während aktiv sind alle Menü-Wörter außer dem eigens dafür erzeugten "z"
// ausgeblendet, die Konsole zeigt statisch "connect" (siehe notice-board.js),
// und ein Bildklick wählt/entwählt statt zu öffnen (siehe gallery oben).
// ─────────────────────────────────────────────
const connectCancelEl = document.createElement('div');
connectCancelEl.className = 'menu-word';
connectCancelEl.textContent = 'z';
connectCancelEl.style.display = 'none';
menuLayer.appendChild(connectCancelEl);

const connectConfirmEl = document.createElement('div');
connectConfirmEl.className = 'menu-word';
connectConfirmEl.textContent = 'connect';
connectConfirmEl.style.display = 'none';
menuLayer.appendChild(connectConfirmEl);

// Übersicht der aktuell ausgewählten Bilder -- oben, neben der Konsole,
// bleibt beim Scrollen der Galerie fest stehen (siehe #connect-selection-bar
// in style.css). Erscheint erst mit der ersten Auswahl (siehe
// toggleConnectSelection), sammelt pro Auswahl eine Miniaturansicht; Klick
// darauf entwählt dasselbe Bild wieder.
const connectSelectionBar = document.getElementById('connect-selection-bar');
const connectSelectionThumbs = new Map();

function addSelectionThumb(img) {
  const thumb = document.createElement('img');
  thumb.className = 'connect-selection-thumb';
  thumb.src = img.url;
  thumb.addEventListener('click', () => toggleConnectSelection(img));
  connectSelectionBar.appendChild(thumb);
  connectSelectionThumbs.set(img.id, thumb);
  connectSelectionBar.style.display = 'flex';
  // Die Leiste kann durch diese neue Kachel gewachsen sein (z.B. neue
  // Zeile) -- "z"/"connect" ggf. sofort aus ihrem (jetzt größeren)
  // Bereich herauskorrigieren.
  correctWordsForSelectionBar();
}

function removeSelectionThumb(img) {
  const thumb = connectSelectionThumbs.get(img.id);
  if (thumb) {
    thumb.remove();
    connectSelectionThumbs.delete(img.id);
  }
  if (connectSelectionThumbs.size === 0) connectSelectionBar.style.display = 'none';
}

function clearSelectionThumbs() {
  connectSelectionBar.innerHTML = '';
  connectSelectionThumbs.clear();
  connectSelectionBar.style.display = 'none';
}

// connect-Galerie-Kacheln sind im Auswahl-Modus nicht auswählbar (siehe
// toggleConnectSelection) -- sollen dort also erst gar nicht angezeigt
// werden, statt unklickbar in der Galerie herumzuliegen.
function setConnectTilesVisible(visible) {
  gallery.getImages().forEach((img) => {
    if (img.kind !== 'connect') return;
    const el = gallery.elements.get(img.id);
    if (el) el.style.display = visible ? 'block' : 'none';
  });
}

function setImageSelected(img, selected) {
  const el = gallery.elements.get(img.id);
  if (el) el.classList.toggle('connect-selected', selected);
}

// Erscheint erst ab mindestens 2 Ausgewählten (siehe Vorgabe) -- bekommt bei
// diesem Erscheinen eine eigene Zufallsposition, bleibt danach an ihrer
// Stelle stehen (kein Neu-Würfeln bei jedem weiteren Auswählen).
function updateConnectConfirmVisibility() {
  const shouldShow = selectedConnectIds.size >= 2;
  const wasShown = connectConfirmEl.style.display === 'block';
  connectConfirmEl.style.display = shouldShow ? 'block' : 'none';
  if (shouldShow && !wasShown) {
    const taken = [{
      x: parseFloat(connectCancelEl.style.left) || 0,
      y: parseFloat(connectCancelEl.style.top) || 0,
    }];
    const spot = randomSpotUtil(taken, { margin: 60, minDist: 140, avoidRects: [SELECTION_BAR_ESTIMATED_ZONE] });
    connectConfirmEl.style.left = spot.x + 'px';
    connectConfirmEl.style.top = spot.y + 'px';
    clampToViewport(connectConfirmEl);
    correctWordsForSelectionBar();
  }
}

// Nur einzelne Bilder sind auswählbar -- eine bereits bestehende
// connect-Galerie lässt sich nicht (verschachtelt) in eine neue mit
// aufnehmen.
function toggleConnectSelection(img) {
  if (img.kind === 'connect') return;
  if (selectedConnectIds.has(img.id)) {
    selectedConnectIds.delete(img.id);
    setImageSelected(img, false);
    removeSelectionThumb(img);
  } else {
    selectedConnectIds.add(img.id);
    setImageSelected(img, true);
    addSelectionThumb(img);
  }
  updateConnectConfirmVisibility();
}

// Reservierte Zone oben für die Auswahl-Übersicht (#connect-selection-bar,
// siehe style.css) -- "z"/"connect" sollen nie darin (oder dahinter
// versteckt) landen. Fester Schätzwert für die ERSTE Platzierung (die
// Leiste kann zu diesem Zeitpunkt noch leer/unsichtbar sein, siehe
// enterConnectMode -- vor jeder Auswahl); die tatsächliche, ggf. gewachsene
// Höhe wird zusätzlich bei jeder Änderung der Auswahl live nachkorrigiert
// (siehe correctWordsForSelectionBar).
const SELECTION_BAR_ESTIMATED_ZONE = { left: 0, right: Infinity, top: 0, bottom: 140 };

function getSelectionBarAvoidRect() {
  if (connectSelectionBar.style.display !== 'flex') return null;
  const r = connectSelectionBar.getBoundingClientRect();
  return { left: 0, right: window.innerWidth, top: 0, bottom: r.bottom };
}

// Schiebt "z"/"connect" (falls nötig) aus dem TATSÄCHLICHEN Bereich der
// Auswahl-Übersicht heraus -- läuft bei jeder Änderung der Auswahl (siehe
// addSelectionThumb/removeSelectionThumb), da die Leiste dabei wachsen/
// schrumpfen kann (mehr/weniger Miniaturansichten, ggf. mehrzeilig) und der
// feste Schätzwert von oben das nicht immer trifft.
function correctWordsForSelectionBar() {
  const rect = getSelectionBarAvoidRect();
  if (!rect) return;
  [connectCancelEl, connectConfirmEl].forEach((el) => {
    if (el.style.display !== 'block') return;
    for (let pass = 0; pass < 4; pass++) {
      clampFromRect(el, rect, 10);
      clampToViewport(el, 32);
    }
  });
}

function repositionConnectModeWords() {
  const taken = [];
  const zSpot = randomSpotUtil(taken, { margin: 60, minDist: 140, avoidRects: [SELECTION_BAR_ESTIMATED_ZONE] });
  taken.push(zSpot);
  connectCancelEl.style.left = zSpot.x + 'px';
  connectCancelEl.style.top = zSpot.y + 'px';
  clampToViewport(connectCancelEl);

  if (connectConfirmEl.style.display === 'block') {
    const spot = randomSpotUtil(taken, { margin: 60, minDist: 140, avoidRects: [SELECTION_BAR_ESTIMATED_ZONE] });
    connectConfirmEl.style.left = spot.x + 'px';
    connectConfirmEl.style.top = spot.y + 'px';
    clampToViewport(connectConfirmEl);
  }
  correctWordsForSelectionBar();
}

function enterConnectMode() {
  if (connectModeActive) return;
  connectModeActive = true;
  MENU_WORDS.forEach((word) => { menuEls[word].style.display = 'none'; });
  setConnectTilesVisible(false);
  setClockVisible(false);
  connectCancelEl.style.display = 'block';
  repositionConnectModeWords();
  showStickyMessage('connect');
}

function exitConnectMode() {
  if (!connectModeActive) return;
  connectModeActive = false;
  selectedConnectIds.forEach((id) => {
    const el = gallery.elements.get(id);
    if (el) el.classList.remove('connect-selected');
  });
  selectedConnectIds.clear();
  clearSelectionThumbs();
  setConnectTilesVisible(true);
  connectCancelEl.style.display = 'none';
  connectConfirmEl.style.display = 'none';
  MENU_WORDS.forEach((word) => { menuEls[word].style.display = 'block'; });
  clearStickyMessage();
  repositionClockForMain(repositionMainMenu());
}

connectCancelEl.addEventListener('click', exitConnectMode);

connectConfirmEl.addEventListener('click', async () => {
  const chosen = gallery.getImages().filter((img) => selectedConnectIds.has(img.id));
  const created = await createConnectGallery(chosen.map((img) => ({
    id: img.id, url: img.url, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
  })));
  if (!created) {
    flashMessage('error: could not create gallery');
    return;
  }
  exitConnectMode();
  gallery.addImage(toConnectGalleryPreviewItem(created));
  showMessage('successfully connected');
});

// ─────────────────────────────────────────────
// Shortcuts — nur Tasten mit sichtbarem Element-Gegenstück
// ─────────────────────────────────────────────
clockEl.addEventListener('click', () => gallery.sortChronological());
menuEls.s.addEventListener('click', () => gallery.shuffleRandom());
// Auf main entscheidet [r] per Zufall zwischen einem einzelnen Bild und
// einer connect-Galerie (im single view/in der connect-Galerie selbst
// bleibt [r] dagegen jeweils exklusiv bei ihrer eigenen Art, siehe dort).
// connectView.showRandom() meldet zurück, ob es (noch) überhaupt eine
// connect-Galerie gab -- sonst bliebe [r] bei der 50%-Zufallsentscheidung
// "Galerie" ohne jede vorhandene Galerie sichtbar wirkungslos.
async function browseRandomAnything() {
  if (Math.random() < 0.5) {
    const found = await connectView.showRandom();
    if (!found) singleView.showRandom();
  } else {
    singleView.showRandom();
  }
}
menuEls.r.addEventListener('click', browseRandomAnything);
menuEls.i.addEventListener('click', () => showRandomHint());
menuEls.c.addEventListener('click', enterConnectMode);

// ─────────────────────────────────────────────
// Push-Upload — echt an Supabase angebunden, kein Login nötig
// ─────────────────────────────────────────────
const fileInput = document.getElementById('file-input');
menuEls.push.addEventListener('click', () => {
  fileInput.click();
});

upload = initUpload({
  fileInput,
  overlay: document.getElementById('upload-overlay'),
  preview: document.getElementById('upload-preview'),
  escBtn: document.getElementById('upload-esc'),
  submitBtn: document.getElementById('upload-push'),
  consentToggleEl: document.getElementById('upload-consent-toggle'),
  consentHintEl: document.getElementById('upload-consent-hint'),
  consentClaimEl: document.getElementById('upload-consent-claim'),
  consentCirculateEl: document.getElementById('upload-consent-circulate'),
  consentResponsibilityEl: document.getElementById('upload-consent-responsibility'),
  countdownEl: document.getElementById('upload-countdown'),
  copyrightEl: document.getElementById('upload-copyright'),
}, (img) => gallery.addImage(img));

initDragDrop({
  onFileDropped: (file) => upload.handleFile(file),
  // Dieselbe Bedingung wie beim [p]-Kurzbefehl für push: nicht auslösen,
  // während eine andere Vollbild-Ansicht offen ist (Überlagerung von
  // Overlays). Bereits offenes Upload-Fenster ist erlaubt — ein Drop
  // ersetzt dann einfach das aktuell ausgewählte Bild.
  isDropAllowed: () => {
    const blocking = ['single-view', 'vrp-view', 'connect-view'];
    return !connectModeActive && !blocking.some((id) => document.getElementById(id).style.display === 'block');
  },
});

// [esc] ist in Safari nicht immer zuverlässig auslösbar — [z] ("back") macht
// dieselbe Funktion zusätzlich verfügbar, ersetzt [esc] aber nicht.
function closeActiveOverlay() {
  const singleViewEl = document.getElementById('single-view');
  const uploadEl = document.getElementById('upload-overlay');
  const vrpViewEl = document.getElementById('vrp-view');
  const connectViewEl = document.getElementById('connect-view');

  if (connectModeActive) {
    exitConnectMode();
  } else if (singleViewEl.style.display === 'block') {
    document.getElementById('single-esc').click();
  } else if (uploadEl.style.display === 'block') {
    document.getElementById('upload-esc').click();
  } else if (vrpViewEl.style.display === 'block') {
    document.getElementById('vrp-esc').click();
  } else if (connectViewEl.style.display === 'block') {
    document.getElementById('connect-esc').click();
  }
}

document.addEventListener('keydown', (e) => {
  const typingInInput = document.activeElement && document.activeElement.tagName === 'INPUT';

  if (e.key === 'Escape') {
    closeActiveOverlay();
    return;
  }

  if (typingInInput) return;

  const hidden = document.body.classList.contains('hide-text');
  // Während der Bildauswahl (siehe [c] unten) sind push/shuffle/browse/hint
  // bewusst gesperrt -- die einzigen Aktionen sind Bilder (an-/abwählen),
  // [z] (abbrechen) und der "connect"-Klick selbst.
  const blockedForConnectMode = ['single-view', 'vrp-view', 'upload-overlay', 'connect-view'];
  const noOtherOverlayOpen = !blockedForConnectMode.some((id) => isOpen(id)) && !connectModeActive;

  // [z] nur außerhalb von Texteingaben, sonst würde jedes getippte "z" die
  // aktuelle Ansicht schließen.
  if (e.key === 'z' || e.key === 'Z') {
    closeActiveOverlay();
  }

  if (e.key === 's' || e.key === 'S') {
    if (noOtherOverlayOpen) gallery.shuffleRandom();
  }
  // Kein eigenes Textelement (bewusst "geheim") -- entspricht exakt dem
  // Klick auf die Uhr (chronologisch anordnen).
  if (e.key === 't' || e.key === 'T') {
    if (noOtherOverlayOpen) gallery.sortChronological();
  }
  if (e.key === 'c' || e.key === 'C') {
    if (noOtherOverlayOpen) enterConnectMode();
  }
  if (e.key === 'r' || e.key === 'R') {
    if (isOpen('single-view')) {
      document.getElementById('single-r').click();
    } else if (isOpen('connect-view')) {
      document.getElementById('connect-r').click();
    } else if (noOtherOverlayOpen) {
      menuEls.r.click();
    }
  }
  if ((e.key === 'p' || e.key === 'P') && !hidden) {
    if (isOpen('upload-overlay')) {
      document.getElementById('upload-push').click();
    } else if (!isOpen('single-view') && !connectModeActive) {
      menuEls.push.click();
    }
  }
  if ((e.key === 'j' || e.key === 'J') && isOpen('vrp-view')) {
    vrp.filterJournal();
  }
  if ((e.key === 'e' || e.key === 'E') && isOpen('vrp-view')) {
    vrp.filterEssay();
  }
  if ((e.key === 'i' || e.key === 'I') && !hidden && !connectModeActive) showRandomHint();
  if (e.key === '*' || e.key === '+' || (e.shiftKey && e.key === '=')) {
    // Einstieg in den *-Modus nur auf Seiten mit Bildern (Hauptgalerie,
    // Einzelansicht, Upload). Das Verlassen (bereits aktiv) geht immer.
    const hasImages = !isOpen('vrp-view');
    if (hidden || hasImages) hideTextMode.toggle();
  }
});

// ─────────────────────────────────────────────
// URL-Routing: /image/:id, /vrp. Die eigentlichen history.pushState()-
// Aufrufe passieren direkt in den open()-Funktionen der jeweiligen Ansicht
// (siehe router.js) — hier wird nur die Gegenrichtung behandelt: eine (neue
// oder per Vor-/Zurück erreichte) URL in den passenden offenen/geschlossenen
// View-Zustand übersetzen.
// ─────────────────────────────────────────────

// Schließt direkt über close() (nicht über einen Klick auf den esc-Button),
// damit dabei nicht zusätzlich goBack() ausgelöst wird — die URL hat sich in
// diesem Fall ja bereits geändert, das hier zieht nur den View-Zustand nach.
async function syncViewToRoute(route) {
  if (route.type !== 'image' && isOpen('single-view')) {
    singleView.close();
  }
  if (route.type !== 'vrp' && isOpen('vrp-view')) vrp.close();

  if (route.type === 'image') {
    await singleView.open(route.id);
  } else if (route.type === 'vrp') {
    if (!isOpen('vrp-view')) vrp.open();
    else document.title = 'push v.r.p. — v.r.p.';
  } else {
    document.title = 'push v.r.p.';
  }
}

// Browser-Vor-/Zurück: die URL hat sich bereits geändert — nur den
// View-Zustand nachziehen, dabei keine neue History-Eintragung erzeugen.
window.addEventListener('popstate', () => {
  runSilently(() => syncViewToRoute(parseRoute(location.pathname)));
});

// ─────────────────────────────────────────────
// Welcome-Seite — nur beim allerersten Besuch (siehe welcome.js)
// ─────────────────────────────────────────────
initWelcome({
  overlay: document.getElementById('welcome-view'),
  pushEl: document.getElementById('welcome-push'),
}, () => {
  // Erst wenn die Welcome-Seite (falls angezeigt) durchgelaufen ist, eine per
  // URL adressierte Ansicht öffnen — sonst würde sie z.B. beim allerersten
  // Besuch mit einem geteilten Link "push" sofort verdecken.
  const route = parseRoute(location.pathname);
  if (route.type === 'home') return;
  runSilently(() => syncViewToRoute(route)).then(() => markOpenedFromDirectLoad());
});

// ─────────────────────────────────────────────
// Fenstergrößenänderung: Die Anordnung passt sich an die neue Breite an —
// Bild- und Schriftgrößen bleiben dabei unverändert, nur die Positionen
// reagieren. Debounced, damit während des Ziehens am Fensterrand nicht
// laufend neu gewürfelt wird.
//
// Mobile Browser feuern "resize" auch, wenn sich nur die Höhe ändert (Adress-
// leiste beim Scrollen ein-/ausblenden, Tastatur öffnet/schließt) — ohne dass
// sich am Layout tatsächlich etwas anpassen müsste. Da relayout()/reposition()
// dabei neu würfeln, ließ das Inhalte beim bloßen Scrollen leicht "wandern".
// Reagiert daher nur noch auf echte Breitenänderungen.
// ─────────────────────────────────────────────
let resizeTimeout = null;
let lastWindowWidth = window.innerWidth;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (window.innerWidth === lastWindowWidth) return;
    lastWindowWidth = window.innerWidth;

    gallery.relayout();
    [...Object.values(menuEls), clockEl, vrpEl, connectCancelEl, connectConfirmEl]
      .forEach((el) => clampToViewport(el));

    singleView.reposition();
    if (isOpen('upload-overlay')) upload.reposition();
    if (isOpen('vrp-view')) vrp.reposition();
    if (isOpen('connect-view')) connectView.reposition();
  }, 250);
});

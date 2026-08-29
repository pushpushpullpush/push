import { fetchImages } from './images-repo.js';
import { fetchAllSeriesSummaries } from './series-repo.js';
import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';
import { createGallery } from './gallery.js';
import { initUpload } from './upload.js';
import { initDragDrop } from './drag-drop.js';
import { initSingleView } from './single-view.js';
import { initVrp } from './vrp.js';
import { mountClock, setClockVisible } from './clock.js';
import { mountNoticeConsole, showRandomHint } from './notice-board.js';
import { initHideTextMode } from './star-toggle.js';
import { clampToViewport, randomSpot as randomSpotUtil } from './position-utils.js';
import { initWelcome } from './welcome.js';
import {
  parseRoute, runSilently, markOpenedFromDirectLoad, pushRoute, HOME_PATH, HOME_TITLE,
} from './router.js';

const stage = document.getElementById('stage');
const menuLayer = document.getElementById('menu-layer');

// Gespeicherte Reihen (siehe series-repo.js/Ausbaustufe A2) laufen komplett
// ungepaginiert mit -- ihre Anzahl dürfte auf absehbare Zeit deutlich
// kleiner bleiben als die Anzahl gepushter Bilder (siehe fetchAllImages()-
// Kommentar in images-repo.js für dieselbe Abwägung). Beide Listen tragen
// ihr eigenes created_at (Zeitpunkt des Pushens bzw. Speicherns) und werden
// hier zu EINER chronologisch korrekt sortierten Anfangsliste gemischt.
const [images, seriesSummaries] = await Promise.all([
  fetchImages({ limit: 60 }),
  fetchAllSeriesSummaries(),
]);
const initialGalleryItems = [...images, ...seriesSummaries]
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

// Kleiner Kreisverweis: gallery ruft singleView.open() auf, singleView braucht
// gallery.getImages — beide werden daher über eine verzögerte Referenz verbunden.
let singleView;
let upload;

function isOpen(id) {
  return document.getElementById(id).style.display === 'block';
}

const gallery = createGallery(stage, initialGalleryItems, {
  onImageClick: (img) => singleView.open(img.id),
  onSeriesClick: (img) => singleView.openSavedSeries(img.id),
  onSortModeChange: (mode) => {
    // "a" (zurück zur chronologischen Ordnung) ist nur sichtbar, solange man
    // NICHT bereits chronologisch ist — im Startzustand also ausgeblendet.
    menuEls.a.style.display = mode === 'random' ? 'block' : 'none';
  },
});

// ─────────────────────────────────────────────
// Nachladen beim Scrollen — löst die feste 300er-Grenze durch echtes,
// endloses Nachladen in kleinen Häppchen ab. Bezieht sich bewusst nur auf
// "images" (normale Bilder), nicht auf initialGalleryItems -- gespeicherte
// Reihen sind ja bereits vollständig geladen (siehe oben) und wachsen beim
// Scrollen nie nach.
// ─────────────────────────────────────────────
let oldestLoadedAt = images.length ? images[images.length - 1].createdAt : null;
let loadingMore = false;
let noMoreImages = images.length < 60;

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
  connectBtn: document.getElementById('single-connect'),
  pushBtn: document.getElementById('single-push'),
  connectionsStage: document.getElementById('single-connections-stage'),
  seriesOverlay: document.getElementById('connect-series-view'),
  seriesStage: document.getElementById('connect-series-stage'),
  seriesPickerEl: document.getElementById('connect-series-picker'),
  seriesPickerInnerEl: document.getElementById('connect-series-picker-inner'),
  seriesCandidates: document.getElementById('connect-series-candidates'),
  seriesEsc: document.getElementById('connect-series-esc'),
  seriesConfirmWord: document.getElementById('connect-series-confirm'),
  seriesFixEl: document.getElementById('connect-series-fix'),
  seriesSEl: document.getElementById('connect-series-s'),
  seriesAEl: document.getElementById('connect-series-a'),
  seriesRandomEl: document.getElementById('connect-series-r'),
  seriesPushEl: document.getElementById('connect-series-push'),
}, gallery.getImages, gallery.getSortMode, (entry) => gallery.addSeries(entry));

// ─────────────────────────────────────────────
// Fixe Menü-Textelemente: bei jedem vollen Laden neu platziert,
// bleiben beim Scrollen an ihrer Position (position: fixed).
// ─────────────────────────────────────────────
const MENU_WORDS = ['push', 'a', 's', 'r', 'i'];
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

// Startzustand der Hauptgalerie ist chronologisch — der Rückweg dorthin
// ("a") ist daher erst nach einem Shuffle sichtbar.
menuEls.a.style.display = 'none';

// ─────────────────────────────────────────────
// Datum/Uhrzeit — eigenes Modul, liegt über allem (auch über Overlays)
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
  repositionClockForMain(repositionMainMenu());
});
document.getElementById('upload-esc').addEventListener('click', () => { repositionClockForMain(repositionMainMenu()); });
document.getElementById('vrp-esc').addEventListener('click', () => { repositionClockForMain(repositionMainMenu()); });

// ─────────────────────────────────────────────
// Shortcuts — nur Tasten mit sichtbarem Element-Gegenstück
// ─────────────────────────────────────────────
menuEls.a.addEventListener('click', () => gallery.sortChronological());
menuEls.s.addEventListener('click', () => gallery.shuffleRandom());
menuEls.r.addEventListener('click', () => singleView.showRandom());
menuEls.i.addEventListener('click', () => showRandomHint());

// ─────────────────────────────────────────────
// Push-Upload — echt an Supabase angebunden, kein Login nötig
// ─────────────────────────────────────────────
const fileInput = document.getElementById('file-input');
menuEls.push.addEventListener('click', () => {
  fileInput.click();
});

// "push" auch aus der Einzelansicht und der schreibgeschützten Gallery-
// Ansicht heraus (nicht während einer aktiven Aktion, siehe Kommentar bei
// isSeriesReadOnly in single-view.js): schließt die aktuelle Ansicht wie
// ein "z", genau wie beim Wechsel zwischen anderen Ansichten dieser Seite
// gibt es nie zwei offene Overlays gleichzeitig.
function triggerPushFromView() {
  singleView.close();
  pushRoute(HOME_PATH, HOME_TITLE);
  repositionClockForMain(repositionMainMenu());
  fileInput.click();
}
document.getElementById('single-push').addEventListener('click', triggerPushFromView);
document.getElementById('connect-series-push').addEventListener('click', triggerPushFromView);

upload = initUpload({
  fileInput,
  overlay: document.getElementById('upload-overlay'),
  preview: document.getElementById('upload-preview'),
  escBtn: document.getElementById('upload-esc'),
  submitBtn: document.getElementById('upload-push'),
}, (img) => gallery.addImage(img));

initDragDrop({
  onFileDropped: (file) => upload.handleFile(file),
  // Dieselbe Bedingung wie beim [p]-Kurzbefehl für push: nicht auslösen,
  // während eine andere Vollbild-Ansicht offen ist (Überlagerung von
  // Overlays). Bereits offenes Upload-Fenster ist erlaubt — ein Drop
  // ersetzt dann einfach das aktuell ausgewählte Bild.
  isDropAllowed: () => {
    const blocking = ['single-view', 'vrp-view', 'connect-series-view'];
    return !blocking.some((id) => document.getElementById(id).style.display === 'block');
  },
});

// [esc] ist in Safari nicht immer zuverlässig auslösbar — [z] ("back") macht
// dieselbe Funktion zusätzlich verfügbar, ersetzt [esc] aber nicht.
function closeActiveOverlay() {
  const singleViewEl = document.getElementById('single-view');
  const uploadEl = document.getElementById('upload-overlay');
  const vrpViewEl = document.getElementById('vrp-view');
  const connectSeriesEl = document.getElementById('connect-series-view');

  // connect-Ansicht zuerst prüfen: [z] dort führt zum jeweils vorherigen
  // Schritt zurück bzw. über goBack() zur Hauptgalerie (siehe
  // single-view.js) — eigene, von der normalen Einzelansicht abweichende
  // Logik.
  if (connectSeriesEl.style.display === 'block') {
    document.getElementById('connect-series-esc').click();
  } else if (singleViewEl.style.display === 'block') {
    document.getElementById('single-esc').click();
  } else if (uploadEl.style.display === 'block') {
    document.getElementById('upload-esc').click();
  } else if (vrpViewEl.style.display === 'block') {
    document.getElementById('vrp-esc').click();
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

  // [z] nur außerhalb von Texteingaben, sonst würde jedes getippte "z" die
  // aktuelle Ansicht schließen.
  if (e.key === 'z' || e.key === 'Z') {
    closeActiveOverlay();
  }

  const inConnectFlow = isOpen('connect-series-view');

  if (e.key === 'a' || e.key === 'A') {
    if (isOpen('connect-series-view')) {
      document.getElementById('connect-series-a').click();
    } else if (!isOpen('single-view') && !isOpen('vrp-view') && !isOpen('upload-overlay') && !inConnectFlow) {
      gallery.sortChronological();
    }
  }
  if (e.key === 's' || e.key === 'S') {
    if (isOpen('connect-series-view')) {
      document.getElementById('connect-series-s').click();
    } else if (!isOpen('single-view') && !isOpen('vrp-view') && !isOpen('upload-overlay') && !inConnectFlow) {
      gallery.shuffleRandom();
    }
  }
  if (e.key === 'r' || e.key === 'R') {
    if (isOpen('single-view')) {
      document.getElementById('single-r').click();
    } else if (isOpen('connect-series-view')) {
      // "r" (zufällig durch gespeicherte Reihen browsen) -- self-guarded in
      // single-view.js (nur in der schreibgeschützten Ansicht wirksam,
      // siehe showRandomSeries/updateSeriesRandomVisibility).
      document.getElementById('connect-series-r').click();
    } else if (!isOpen('vrp-view') && !isOpen('upload-overlay') && !inConnectFlow) {
      menuEls.r.click();
    }
  }
  if (e.key === 'c' || e.key === 'C') {
    if (isOpen('single-view')) {
      document.getElementById('single-connect').click();
    }
  }
  if (e.key === 'g' || e.key === 'G') {
    // Zweistufige "g" -> "create gallery" -> Speichern-Aktion -- der
    // eigentliche Klick-Handler in single-view.js ist self-guarded
    // (Vorschau/schreibgeschützt/Länge < 3), unabhängig von der
    // Sichtbarkeit hier.
    if (isOpen('connect-series-view')) {
      document.getElementById('connect-series-fix').click();
    }
  }
  if ((e.key === 'p' || e.key === 'P') && !hidden) {
    if (isOpen('upload-overlay')) {
      document.getElementById('upload-push').click();
    } else if (isOpen('single-view')) {
      document.getElementById('single-push').click();
    } else if (isOpen('connect-series-view')) {
      // Nur in der schreibgeschützten Gallery-Ansicht erlaubt, nicht
      // während einer aktiven Aktion (Connect-Auswahl, Reihe bauen).
      if (singleView.isSeriesReadOnly()) document.getElementById('connect-series-push').click();
    } else {
      menuEls.push.click();
    }
  }
  if ((e.key === 'j' || e.key === 'J') && isOpen('vrp-view')) {
    vrp.filterJournal();
  }
  if ((e.key === 'e' || e.key === 'E') && isOpen('vrp-view')) {
    vrp.filterEssay();
  }
  if ((e.key === 'i' || e.key === 'I') && !hidden) showRandomHint();
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
  // singleView.close() räumt sowohl die normale Einzelansicht als auch eine
  // evtl. offene Reihen-Ansicht (inkl. Auswahl-Zwischenschritt) auf -- open()
  // bzw. openSeriesFromRoute()/openSavedSeries() übernehmen danach jeweils
  // selbst, die jeweils andere Ansicht zusätzlich defensiv zu schließen
  // (siehe dort).
  const staysInSingleViewFamily = route.type === 'image' || route.type === 'connect' || route.type === 'series';
  if (!staysInSingleViewFamily && (isOpen('single-view') || isOpen('connect-series-view'))) {
    singleView.close();
  }
  if (route.type !== 'vrp' && isOpen('vrp-view')) vrp.close();

  if (route.type === 'image') {
    await singleView.open(route.id);
  } else if (route.type === 'connect') {
    await singleView.openSeriesFromRoute(route.ids[0], route.ids[1]);
  } else if (route.type === 'series') {
    await singleView.openSavedSeries(route.id);
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
    [...Object.values(menuEls), clockEl, vrpEl].forEach((el) => clampToViewport(el));

    // reposition() prüft selbst, welche seiner drei Ansichten (Einzelansicht,
    // connect-Auswahl, connect-Bestätigung) gerade offen ist.
    singleView.reposition();
    if (isOpen('upload-overlay')) upload.reposition();
    if (isOpen('vrp-view')) vrp.reposition();
  }, 250);
});

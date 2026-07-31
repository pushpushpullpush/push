import { fetchImages } from './images-repo.js';
import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';
import { createGallery } from './gallery.js';
import { initUpload } from './upload.js';
import { initDragDrop } from './drag-drop.js';
import { initSingleView } from './single-view.js';
import { initAuth } from './auth.js';
import { initOwnGallery } from './own-gallery.js';
import { initForeignProfile } from './foreign-profile.js';
import { initTrace } from './trace.js';
import { initVrp } from './vrp.js';
import { searchUsernames } from './profile-data.js';
import { mountClock, setClockVisible } from './clock.js';
import { mountNoticeConsole, showRandomHint } from './notice-board.js';
import { initHideTextMode } from './star-toggle.js';
import { mountShootWord, repositionShootWord, trigger as triggerShoot } from './shoot.js';
import { clampToViewport, randomSpot as randomSpotUtil } from './position-utils.js';
import { initWelcome } from './welcome.js';
import {
  parseRoute, runSilently, markOpenedFromDirectLoad,
} from './router.js';

const stage = document.getElementById('stage');
const menuLayer = document.getElementById('menu-layer');

const images = await fetchImages({ limit: 60 });

// Kleiner Kreisverweis: gallery ruft singleView.open() auf, singleView braucht
// gallery.getImages — beide werden daher über eine verzögerte Referenz verbunden.
// Gleiches Prinzip für singleView <-> trace/upload (reproduce/trace rufen
// jeweils die Öffnen-Funktion der anderen Seite auf, siehe unten).
let singleView;
let ownGallery;
let foreignProfile;
let trace;
let upload;

function openProfile(username) {
  const user = auth.getCurrentUser();
  if (user && user.username === username) {
    ownGallery.open();
  } else {
    foreignProfile.open(username);
  }
}

function isOpen(id) {
  return document.getElementById(id).style.display === 'block';
}

const gallery = createGallery(stage, images, {
  onImageClick: (img) => singleView.open(img.id),
});

// ─────────────────────────────────────────────
// Nachladen beim Scrollen — löst die feste 300er-Grenze durch echtes,
// endloses Nachladen in kleinen Häppchen ab.
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
      tags: row.tags || [],
      familyRootId: row.family_root_id,
      generation: row.generation,
    }]);
  })
  .subscribe();

singleView = initSingleView({
  overlay: document.getElementById('single-view'),
  imageEl: document.getElementById('single-image'),
  escBtn: document.getElementById('single-esc'),
  zBtn: document.getElementById('single-z'),
  pullBtn: document.getElementById('single-pull'),
  commentBtn: document.getElementById('single-comment'),
  reportBtn: document.getElementById('single-report'),
  reproduceBtn: document.getElementById('single-reproduce'),
  traceBtn: document.getElementById('single-trace'),
  viewsEl: document.getElementById('single-views'),
  commentsLayer: document.getElementById('single-comments-layer'),
  dimEsc: document.getElementById('single-dim-esc'),
  typeInput: document.getElementById('single-type-input'),
  submitBtn: document.getElementById('single-submit'),
  thanksEl: document.getElementById('single-thanks'),
}, gallery.getVisibleImages, () => auth.getCurrentUser(), () => auth.open(), (imageId, pulled) => {
  // Falls man von der eigenen Galerie aus "drop" drückt: Bild dort sofort entfernen.
  if (!pulled && ownGallery) ownGallery.removeImageIfPresent(imageId);
}, openProfile, (blob, opts) => upload.openWithBlob(blob, opts), (familyRootId, returnImageId) => trace.open(familyRootId, returnImageId));

// ─────────────────────────────────────────────
// Fixe Menü-Textelemente: bei jedem vollen Laden neu platziert,
// bleiben beim Scrollen an ihrer Position (position: fixed).
// ─────────────────────────────────────────────
const MENU_WORDS = ['push', 'pull', 'search', 'a', 'z'];
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

  const el = document.createElement(word === 'search' ? 'input' : 'div');
  el.className = word === 'search' ? 'menu-word italic-field field-yellow' : 'menu-word';
  el.style.left = spot.x + 'px';
  el.style.top = spot.y + 'px';

  if (word === 'search') {
    el.type = 'text';
    el.placeholder = 'filter';
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        el.value = '';
        el.placeholder = 'filter';
        el.blur();
        gallery.filterByTag('');
        gallery.clearUsernameChips();
      } else if (e.key === 'Enter') {
        el.blur();
      }
    });
    el.addEventListener('blur', () => {
      if (el.value.trim() === '') {
        el.placeholder = 'filter';
      }
    });
  } else {
    // Auf der Hauptseite heißt es "collection" — in der Einzelansicht
    // bleibt es bei "pull", intern heißt der Schlüssel weiterhin "pull".
    el.textContent = word === 'pull' ? 'collection' : word;
  }

  menuLayer.appendChild(el);
  menuEls[word] = el;
  clampToViewport(el);
});

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

mountShootWord();
const shootSpot = repositionShootWord(placed);
if (shootSpot) placed.push(shootSpot);

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
  const shootSpotNew = repositionShootWord(taken);
  if (shootSpotNew) taken.push(shootSpotNew);
}

function repositionClockForMain() {
  setClockVisible(true);
  const spot = randomSpot();
  clockEl.style.left = spot.x + 'px';
  clockEl.style.top = spot.y + 'px';
  clampToViewport(clockEl);
}
document.getElementById('single-esc').addEventListener('click', () => {
  if (document.getElementById('own-gallery-view').style.display === 'block') {
    ownGallery.repositionWords();
  } else if (document.getElementById('foreign-profile-view').style.display === 'block') {
    foreignProfile.repositionWords();
  } else if (document.getElementById('trace-view').style.display === 'block') {
    trace.repositionWords();
  } else {
    repositionMainMenu();
    repositionClockForMain();
  }
});
document.getElementById('upload-esc').addEventListener('click', () => { repositionMainMenu(); repositionClockForMain(); });
document.getElementById('auth-esc').addEventListener('click', () => { repositionMainMenu(); repositionClockForMain(); });
document.getElementById('own-esc').addEventListener('click', () => { repositionMainMenu(); repositionClockForMain(); });
document.getElementById('foreign-esc').addEventListener('click', () => { repositionMainMenu(); repositionClockForMain(); });
document.getElementById('vrp-esc').addEventListener('click', () => { repositionMainMenu(); repositionClockForMain(); });
document.getElementById('trace-esc').addEventListener('click', () => { repositionMainMenu(); repositionClockForMain(); });

// ─────────────────────────────────────────────
// Shortcuts — nur Tasten mit sichtbarem Element-Gegenstück
// ─────────────────────────────────────────────
menuEls.a.addEventListener('click', () => gallery.reshuffleImages());
menuEls.z.addEventListener('click', () => singleView.showRandom());

const auth = initAuth({
  overlay: document.getElementById('auth-view'),
  block: document.getElementById('auth-block'),
  escBtn: document.getElementById('auth-esc'),
  usernameInput: document.getElementById('auth-username'),
  passwordInput: document.getElementById('auth-password'),
  passwordToggle: document.getElementById('auth-password-toggle'),
  enterBtn: document.getElementById('auth-enter'),
  createToggle: document.getElementById('auth-create-toggle'),
  signupFields: document.getElementById('auth-signup-fields'),
  emailInput: document.getElementById('auth-email'),
  newsletterToggle: document.getElementById('auth-newsletter-toggle'),
  forgotEl: document.getElementById('auth-forgot'),
}, (user) => {
  // "enter" gibt es auf der Hauptseite nicht mehr — push/pull ohne Login
  // führen jetzt direkt zum Login-Bildschirm.
});

menuEls.pull.addEventListener('click', () => {
  const user = auth.getCurrentUser();
  if (user) {
    ownGallery.open();
  } else {
    auth.open();
  }
});

ownGallery = initOwnGallery({
  overlay: document.getElementById('own-gallery-view'),
  stage: document.getElementById('own-gallery-stage'),
  usernameEl: document.getElementById('own-username'),
  searchEl: document.getElementById('own-search'),
  zEl: document.getElementById('own-z'),
  aEl: document.getElementById('own-a'),
  escBtn: document.getElementById('own-esc'),
  logoutEl: document.getElementById('own-logout'),
  editEl: document.getElementById('own-edit'),
  newsletterToggle: document.getElementById('own-newsletter-toggle'),
  newsletterLine: document.getElementById('own-newsletter-line'),
  editUsernameLabel: document.getElementById('edit-username-label'),
  editUsernameInput: document.getElementById('edit-username-input'),
  editUsernameConfirm: document.getElementById('edit-username-confirm'),
  editEmailLabel: document.getElementById('edit-email-label'),
  editEmailInput: document.getElementById('edit-email-input'),
  editEmailConfirm: document.getElementById('edit-email-confirm'),
  editPasswordLabel: document.getElementById('edit-password-label'),
  editPasswordInput: document.getElementById('edit-password-input'),
  editPasswordConfirm: document.getElementById('edit-password-confirm'),
  editDeleteLabel: document.getElementById('edit-delete-label'),
  editDeleteInput: document.getElementById('edit-delete-input'),
  editDeleteConfirm: document.getElementById('edit-delete-confirm'),
}, () => auth.getCurrentUser(), (imageId, list) => singleView.open(imageId, list), openProfile);

foreignProfile = initForeignProfile({
  overlay: document.getElementById('foreign-profile-view'),
  stage: document.getElementById('foreign-profile-stage'),
  usernameEl: document.getElementById('foreign-username'),
  searchEl: document.getElementById('foreign-search'),
  zEl: document.getElementById('foreign-z'),
  aEl: document.getElementById('foreign-a'),
  escBtn: document.getElementById('foreign-esc'),
  pullBtn: document.getElementById('foreign-pull'),
}, () => auth.getCurrentUser(), (imageId, list) => singleView.open(imageId, list), openProfile, () => auth.open());

trace = initTrace({
  overlay: document.getElementById('trace-view'),
  stage: document.getElementById('trace-stage'),
  zEl: document.getElementById('trace-z'),
  aEl: document.getElementById('trace-a'),
  escBtn: document.getElementById('trace-esc'),
}, (imageId, list, opts) => singleView.open(imageId, list, opts));

// ─────────────────────────────────────────────
// Push-Upload — echt an Supabase angebunden
// ─────────────────────────────────────────────
const fileInput = document.getElementById('file-input');
menuEls.push.addEventListener('click', () => {
  if (auth.getCurrentUser()) {
    fileInput.click();
  } else {
    auth.open();
  }
});

upload = initUpload({
  fileInput,
  overlay: document.getElementById('upload-overlay'),
  preview: document.getElementById('upload-preview'),
  tagInput: document.getElementById('tag-input'),
  tagChips: document.getElementById('tag-chips'),
  escBtn: document.getElementById('upload-esc'),
  submitBtn: document.getElementById('upload-push'),
}, (img) => gallery.addImage(img));

initDragDrop({
  getCurrentUser: () => auth.getCurrentUser(),
  onNeedsLogin: () => auth.open(),
  onFileDropped: (file) => upload.handleFile(file),
  // Dieselbe Bedingung wie beim [p]-Kurzbefehl für push: nicht auslösen,
  // während eine andere Vollbild-Ansicht offen ist (Überlagerung von
  // Overlays). Bereits offenes Upload-Fenster ist erlaubt — ein Drop
  // ersetzt dann einfach das aktuell ausgewählte Bild.
  isDropAllowed: () => {
    const blocking = ['single-view', 'own-gallery-view', 'foreign-profile-view', 'trace-view', 'auth-view'];
    return !blocking.some((id) => document.getElementById(id).style.display === 'block');
  },
});

let searchDebounce = null;
menuEls.search.addEventListener('input', () => {
  const q = menuEls.search.value;
  gallery.filterByTag(q);
  gallery.clearUsernameChips();

  clearTimeout(searchDebounce);
  if (!q.trim()) return;
  searchDebounce = setTimeout(async () => {
    const matches = await searchUsernames(q);
    matches.forEach((username) => gallery.addUsernameChip(username, openProfile));
  }, 300);
});

// [esc] ist in Safari nicht immer zuverlässig auslösbar — [b] ("back") macht
// dieselbe Funktion zusätzlich verfügbar, ersetzt [esc] aber nicht.
function closeActiveOverlay() {
  const dimEscEl = document.getElementById('single-dim-esc');
  const singleViewEl = document.getElementById('single-view');
  const uploadEl = document.getElementById('upload-overlay');
  const authEl = document.getElementById('auth-view');
  const ownGalleryEl = document.getElementById('own-gallery-view');
  const foreignEl = document.getElementById('foreign-profile-view');
  const vrpViewEl = document.getElementById('vrp-view');
  const traceViewEl = document.getElementById('trace-view');

  if (dimEscEl.style.display === 'block') {
    dimEscEl.click();
  } else if (singleViewEl.style.display === 'block') {
    document.getElementById('single-esc').click();
  } else if (uploadEl.style.display === 'block') {
    document.getElementById('upload-esc').click();
  } else if (authEl.style.display === 'block') {
    document.getElementById('auth-esc').click();
  } else if (ownGalleryEl.style.display === 'block') {
    document.getElementById('own-esc').click();
  } else if (foreignEl.style.display === 'block') {
    document.getElementById('foreign-esc').click();
  } else if (vrpViewEl.style.display === 'block') {
    document.getElementById('vrp-esc').click();
  } else if (traceViewEl.style.display === 'block') {
    document.getElementById('trace-esc').click();
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

  // [b] nur außerhalb von Texteingaben, sonst würde jedes getippte "b" die
  // aktuelle Ansicht schließen.
  if (e.key === 'b' || e.key === 'B') {
    closeActiveOverlay();
  }

  if (e.key === 'a' || e.key === 'A') {
    if (isOpen('single-view') || isOpen('vrp-view')) {
      // "a" existiert in der Einzelansicht und auf v.r.p. nicht
    } else if (isOpen('foreign-profile-view')) {
      document.getElementById('foreign-a').click();
    } else if (isOpen('own-gallery-view')) {
      document.getElementById('own-a').click();
    } else if (isOpen('trace-view')) {
      document.getElementById('trace-a').click();
    } else {
      gallery.reshuffleImages();
    }
  }
  if (e.key === 'z' || e.key === 'Z') {
    if (isOpen('vrp-view')) {
      // "z" existiert auf v.r.p. nicht
    } else if (isOpen('single-view')) {
      document.getElementById('single-z').click();
    } else if (isOpen('foreign-profile-view')) {
      document.getElementById('foreign-z').click();
    } else if (isOpen('own-gallery-view')) {
      document.getElementById('own-z').click();
    } else if (isOpen('trace-view')) {
      document.getElementById('trace-z').click();
    } else {
      menuEls.z.click();
    }
  }
  if ((e.key === 'p' || e.key === 'P') && !hidden) {
    if (isOpen('upload-overlay')) {
      document.getElementById('upload-push').click();
    } else if (!isOpen('single-view') && !isOpen('own-gallery-view') && !isOpen('foreign-profile-view') && !isOpen('auth-view')) {
      menuEls.push.click();
    }
  }
  if (e.key === 'c' || e.key === 'C') {
    if (isOpen('single-view')) {
      document.getElementById('single-pull').click();
    } else if (isOpen('foreign-profile-view')) {
      document.getElementById('foreign-pull').click();
    } else if (!isOpen('own-gallery-view')) {
      menuEls.pull.click();
    }
  }
  if ((e.key === 'n' || e.key === 'N') && !hidden) {
    if (isOpen('single-view')) {
      document.getElementById('single-comment').click();
    }
  }
  if (isOpen('single-view')) {
    if (e.key === 'r' || e.key === 'R') {
      const reproduceEl = document.getElementById('single-reproduce');
      if (getComputedStyle(reproduceEl).display !== 'none') reproduceEl.click();
    }
    if (e.key === 't' || e.key === 'T') {
      const traceEl = document.getElementById('single-trace');
      if (getComputedStyle(traceEl).display !== 'none') traceEl.click();
    }
  }
  if ((e.key === 'f' || e.key === 'F') && !hidden) {
    // Fokussiert direkt das filter-Feld der jeweils sichtbaren Galerie,
    // damit man ohne extra Klick sofort tippen kann.
    if (isOpen('foreign-profile-view')) {
      document.getElementById('foreign-search').focus();
    } else if (isOpen('own-gallery-view')) {
      document.getElementById('own-search').focus();
    } else if (!isOpen('single-view') && !isOpen('auth-view')) {
      menuEls.search.focus();
    }
  }
  if ((e.key === 'j' || e.key === 'J') && isOpen('vrp-view')) {
    vrp.filterJournal();
  }
  if ((e.key === 'e' || e.key === 'E') && isOpen('vrp-view')) {
    vrp.filterEssay();
  }
  if ((e.key === 's' || e.key === 'S') && !isOpen('upload-overlay')) triggerShoot();
  if ((e.key === 'i' || e.key === 'I') && !hidden) showRandomHint();
  if (e.key === '*' || e.key === '+' || (e.shiftKey && e.key === '=')) {
    // Einstieg in den *-Modus nur auf Seiten mit Bildern (Hauptgalerie,
    // Einzelansicht, Upload, fremdes Profil, eigene Galerie im Bildmodus).
    // Das Verlassen (bereits aktiv) geht immer.
    const hasImages = isOpen('own-gallery-view')
      ? ownGallery.hasImages()
      : !isOpen('auth-view') && !isOpen('vrp-view');
    if (hidden || hasImages) hideTextMode.toggle();
  }
});

// ─────────────────────────────────────────────
// URL-Routing: /image/:id, /u/:username, /vrp. Die eigentlichen
// history.pushState()-Aufrufe passieren direkt in den open()-Funktionen der
// jeweiligen Ansicht (siehe router.js) — hier wird nur die Gegenrichtung
// behandelt: eine (neue oder per Vor-/Zurück erreichte) URL in den
// passenden offenen/geschlossenen View-Zustand übersetzen.
// ─────────────────────────────────────────────
function closeProfileViews() {
  if (isOpen('own-gallery-view')) ownGallery.close();
  if (isOpen('foreign-profile-view')) foreignProfile.close();
}

function currentOpenUsername() {
  if (isOpen('own-gallery-view')) {
    const user = auth.getCurrentUser();
    return user ? user.username : null;
  }
  if (isOpen('foreign-profile-view')) {
    return document.getElementById('foreign-username').textContent || null;
  }
  return null;
}

// Schließt direkt über close() (nicht über einen Klick auf den esc-Button),
// damit dabei nicht zusätzlich goBack() ausgelöst wird — die URL hat sich in
// diesem Fall ja bereits geändert, das hier zieht nur den View-Zustand nach.
async function syncViewToRoute(route) {
  // trace ist nie Teil des URL-Schemas (rein lokale Navigation, siehe
  // single-view.js/trace.js) — jede echte Routennavigation (z.B. der
  // physische Zurück-Button des Browsers mitten in einem trace-Ausflug)
  // beendet es einfach, statt in einem inkonsistenten Zustand zu bleiben.
  if (isOpen('trace-view')) trace.close();
  if (route.type !== 'image' && isOpen('single-view')) singleView.close();
  if (route.type !== 'vrp' && isOpen('vrp-view')) vrp.close();
  if (route.type !== 'user' && (isOpen('own-gallery-view') || isOpen('foreign-profile-view'))) {
    closeProfileViews();
  }

  if (route.type === 'image') {
    await singleView.open(route.id);
  } else if (route.type === 'user') {
    if (currentOpenUsername() !== route.username) {
      closeProfileViews();
      openProfile(route.username);
    } else {
      // Bereits die richtige Galerie offen (z.B. Bild darüber wieder
      // geschlossen) — kein erneutes open() nötig, aber der Titel muss
      // trotzdem zurückgesetzt werden, das passiert sonst nur in open().
      document.title = `push v.r.p. — u/${route.username}`;
    }
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

    if (isOpen('single-view')) singleView.reposition();
    if (isOpen('upload-overlay')) upload.reposition();
    if (isOpen('auth-view')) auth.reposition();
    if (isOpen('own-gallery-view')) ownGallery.reflow();
    if (isOpen('foreign-profile-view')) foreignProfile.reflow();
    if (isOpen('trace-view')) trace.reflow();
    if (isOpen('vrp-view')) vrp.reposition();
  }, 250);
});

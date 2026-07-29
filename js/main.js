import { fetchImages } from './images-repo.js';
import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';
import { createGallery } from './gallery.js';
import { initUpload } from './upload.js';
import { initSingleView } from './single-view.js';
import { initAuth } from './auth.js';
import { initOwnGallery } from './own-gallery.js';
import { initForeignProfile } from './foreign-profile.js';
import { initVrp } from './vrp.js';
import { searchUsernames } from './profile-data.js';
import { mountClock } from './clock.js';
import { initHideTextMode } from './star-toggle.js';
import { mountShootWord, repositionShootWord, trigger as triggerShoot } from './shoot.js';
import { clampToViewport, randomSpot as randomSpotUtil } from './position-utils.js';

const stage = document.getElementById('stage');
const menuLayer = document.getElementById('menu-layer');

const images = await fetchImages({ limit: 60 });

// Kleiner Kreisverweis: gallery ruft singleView.open() auf, singleView braucht
// gallery.getImages — beide werden daher über eine verzögerte Referenz verbunden.
let singleView;
let ownGallery;
let foreignProfile;

function openProfile(username) {
  const user = auth.getCurrentUser();
  if (user && user.username === username) {
    ownGallery.open();
  } else {
    foreignProfile.open(username);
  }
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
    gallery.appendImages([{ id: row.id, url: row.url, width, height, tags: row.tags || [] }]);
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
  commentsLayer: document.getElementById('single-comments-layer'),
  dimEsc: document.getElementById('single-dim-esc'),
  typeInput: document.getElementById('single-type-input'),
  submitBtn: document.getElementById('single-submit'),
  thanksEl: document.getElementById('single-thanks'),
}, gallery.getVisibleImages, () => auth.getCurrentUser(), () => auth.open(), (imageId, pulled) => {
  // Falls man von der eigenen Galerie aus "release" drückt: Bild dort sofort entfernen.
  if (!pulled && ownGallery) ownGallery.removeImageIfPresent(imageId);
}, openProfile);

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
    el.placeholder = 'search';
    el.readOnly = true;
    el.addEventListener('click', () => {
      el.readOnly = false;
      el.placeholder = '';
      el.focus();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        el.value = '';
        el.readOnly = true;
        el.placeholder = 'search';
        el.blur();
        gallery.filterByTag('');
        gallery.clearUsernameChips();
      } else if (e.key === 'Enter') {
        el.readOnly = true;
        el.blur();
      }
    });
    el.addEventListener('blur', () => {
      // Falls das Feld irgendwie anders als per esc verlassen wird
      // (z.B. Klick woanders hin): leeres Feld findet sonst niemand wieder.
      el.readOnly = true;
      if (el.value.trim() === '') {
        el.placeholder = 'search';
      }
    });
  } else {
    el.textContent = word;
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
  loginBtn: document.getElementById('auth-login'),
  loginError: document.getElementById('auth-login-error'),
  createToggle: document.getElementById('auth-create-toggle'),
  signupFields: document.getElementById('auth-signup-fields'),
  emailInput: document.getElementById('auth-email'),
  newsletterToggle: document.getElementById('auth-newsletter-toggle'),
  usernameTakenEl: document.getElementById('auth-username-taken'),
  signupError: document.getElementById('auth-signup-error'),
  signupBtn: document.getElementById('auth-signup'),
  forgotEl: document.getElementById('auth-forgot'),
  forgotSentEl: document.getElementById('auth-forgot-sent'),
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
  editSuccessEl: document.getElementById('edit-success'),
  editByebyeEl: document.getElementById('edit-byebye'),
  editErrorEl: document.getElementById('edit-error'),
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

initUpload({
  fileInput,
  overlay: document.getElementById('upload-overlay'),
  preview: document.getElementById('upload-preview'),
  tagInput: document.getElementById('tag-input'),
  tagChips: document.getElementById('tag-chips'),
  escBtn: document.getElementById('upload-esc'),
  submitBtn: document.getElementById('upload-push'),
}, (img) => gallery.addImage(img));

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

document.addEventListener('keydown', (e) => {
  const typingInInput = document.activeElement && document.activeElement.tagName === 'INPUT';

  if (e.key === 'Escape') {
    const dimEscEl = document.getElementById('single-dim-esc');
    const singleViewEl = document.getElementById('single-view');
    const uploadEl = document.getElementById('upload-overlay');
    const authEl = document.getElementById('auth-view');
    const ownGalleryEl = document.getElementById('own-gallery-view');
    const foreignEl = document.getElementById('foreign-profile-view');
    const vrpViewEl = document.getElementById('vrp-view');

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
    }
    return;
  }

  if (typingInInput) return;

  const isOpen = (id) => document.getElementById(id).style.display === 'block';

  const hidden = document.body.classList.contains('hide-text');

  if (e.key === 'a' || e.key === 'A') {
    if (isOpen('single-view')) {
      // "a" existiert in der Einzelansicht nicht
    } else if (isOpen('foreign-profile-view')) {
      document.getElementById('foreign-a').click();
    } else if (isOpen('own-gallery-view')) {
      document.getElementById('own-a').click();
    } else {
      gallery.reshuffleImages();
    }
  }
  if (e.key === 'z' || e.key === 'Z') {
    if (isOpen('single-view')) {
      document.getElementById('single-z').click();
    } else if (isOpen('foreign-profile-view')) {
      document.getElementById('foreign-z').click();
    } else if (isOpen('own-gallery-view')) {
      document.getElementById('own-z').click();
    } else {
      menuEls.z.click();
    }
  }
  if ((e.key === 'c' || e.key === 'C') && !hidden) {
    if (isOpen('single-view')) {
      document.getElementById('single-comment').click();
    }
  }
  if (e.key === 'p' || e.key === 'P') {
    if (isOpen('single-view')) {
      document.getElementById('single-pull').click();
    } else if (isOpen('foreign-profile-view')) {
      document.getElementById('foreign-pull').click();
    } else if (!isOpen('own-gallery-view')) {
      menuEls.pull.click();
    }
  }
  if ((e.key === 'q' || e.key === 'Q') && !hidden) {
    if (isOpen('upload-overlay')) {
      document.getElementById('upload-push').click();
    } else if (!isOpen('single-view') && !isOpen('own-gallery-view') && !isOpen('foreign-profile-view') && !isOpen('auth-view')) {
      menuEls.push.click();
    }
  }
  if ((e.key === 'j' || e.key === 'J') && isOpen('vrp-view')) {
    vrp.filterJournal();
  }
  if ((e.key === 'e' || e.key === 'E') && isOpen('vrp-view')) {
    vrp.filterEssay();
  }
  if (e.key === 's' || e.key === 'S') triggerShoot();
  if (e.key === '*' || e.key === '+' || (e.shiftKey && e.key === '=')) hideTextMode.toggle();
});

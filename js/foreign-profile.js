import { createGallery } from './gallery.js';
import {
  fetchProfileByUsername, fetchUserImages, fetchFollowing,
  isFollowing, follow, unfollow,
} from './profile-data.js';
import { randomSpot, clampToViewport } from './position-utils.js';
import { repositionClock, setClockVisible } from './clock.js';
import { repositionShootWord, setShootWordVisible } from './shoot.js';
import { flashMessage } from './feedback.js';
import { showMessage } from './notice-board.js';
import { flyIntoCollection, getTextCornerRect } from './pull-animation.js';
import { pushRoute, goBack, userPath } from './router.js';

export function initForeignProfile(refs, getCurrentUser, onOpenSingle, onOpenProfile, onNeedsLogin) {
  const { overlay, stage, usernameEl, searchEl, zEl, aEl, escBtn, pullBtn } = refs;

  let gallery = null;
  let currentProfile = null; // { id, username }
  let currentlyFollowing = false;
  let focused = false; // Username-Fokus: nur username + b + collect/drop sichtbar

  function positionWords() {
    const taken = [];
    [usernameEl, searchEl, zEl, aEl, escBtn, pullBtn].forEach((el) => {
      const spot = randomSpot(taken, { margin: 60 });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
    repositionClock(taken);
    repositionShootWord(taken);
  }

  function updatePullLabel() {
    pullBtn.textContent = currentlyFollowing ? 'drop' : 'collect';
  }

  /**
   * Klick auf den fremden Usernamen: blendet alles bis auf den Usernamen
   * selbst aus und zeigt nur noch "b" und "collect"/"drop". Erneuter Klick
   * auf den Usernamen (oder auf "b") kehrt zurück.
   */
  function setFocused(value) {
    focused = value;
    stage.style.display = value ? 'none' : '';
    searchEl.style.display = value ? 'none' : '';
    zEl.style.display = value ? 'none' : '';
    aEl.style.display = value ? 'none' : '';
    // "collect"/"drop" gibt es in der normalen Galerie-Ansicht nicht mehr —
    // nur noch im Username-Fokus.
    pullBtn.style.display = value ? '' : 'none';
    setClockVisible(!value);
    setShootWordVisible(!value);
    updatePullLabel();
  }

  async function refreshFollowState() {
    const user = getCurrentUser();
    if (!user || !currentProfile) {
      currentlyFollowing = false;
      updatePullLabel();
      return;
    }
    currentlyFollowing = await isFollowing(user.id, currentProfile.id);
    updatePullLabel();
  }

  async function loadGallery(profile) {
    stage.innerHTML = '';
    const images = await fetchUserImages(profile.id);
    gallery = createGallery(stage, images, {
      onImageClick: (img) => onOpenSingle(img.id, gallery.getVisibleImages()),
    });

    const following = await fetchFollowing(profile.id);
    following.forEach((uname) => {
      gallery.addUsernameChip(uname, (u) => onOpenProfile(u));
    });
  }

  async function open(username) {
    const user = getCurrentUser();

    // Eigenes Profil aufgerufen? Dann gehört das der eigenen Galerie, nicht hier.
    if (user && user.username === username) {
      console.log('das ist dein eigenes Profil — eigene Galerie öffnen statt fremdes Profil');
      return;
    }

    const profile = await fetchProfileByUsername(username);
    if (!profile) return;

    currentProfile = profile;
    usernameEl.textContent = profile.username;
    overlay.style.display = 'block';
    document.body.style.overflow = 'hidden';
    setFocused(false);
    pushRoute(userPath(profile.username), `push v.r.p. — u/${profile.username}`);

    await loadGallery(profile);

    searchEl.value = '';
    searchEl.placeholder = 'filter';

    await refreshFollowState();
    positionWords();
  }

  function close() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    currentProfile = null;
    focused = false;
    setClockVisible(true);
    setShootWordVisible(true);
  }

  escBtn.addEventListener('click', () => {
    if (focused) setFocused(false);
    else {
      close();
      goBack();
    }
  });

  usernameEl.addEventListener('click', () => {
    if (!currentProfile) return;
    setFocused(!focused);
  });

  aEl.addEventListener('click', () => {
    if (!gallery) return;
    gallery.reshuffleImages();
  });

  zEl.addEventListener('click', () => {
    if (!gallery) return;
    const images = gallery.getVisibleImages();
    if (!images.length) return;
    const pick = images[Math.floor(Math.random() * images.length)];
    onOpenSingle(pick.id, images);
  });

  searchEl.addEventListener('input', () => gallery && gallery.filterByTag(searchEl.value));
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchEl.value = '';
      searchEl.placeholder = 'filter';
      searchEl.blur();
      gallery && gallery.filterByTag('');
    } else if (e.key === 'Enter') {
      searchEl.blur();
    }
  });
  searchEl.addEventListener('blur', () => {
    if (searchEl.value.trim() === '') searchEl.placeholder = 'filter';
  });

  let followAnimationRunning = false;

  async function animateFollowIntoGallery(username) {
    if (followAnimationRunning) return;
    followAnimationRunning = true;
    try {
      const startRect = usernameEl.getBoundingClientRect();
      const startFontSize = getComputedStyle(usernameEl).fontSize;
      const clone = document.createElement('div');
      clone.className = 'username-color';
      clone.textContent = username;
      clone.style.fontSize = startFontSize;

      const user = getCurrentUser();

      await flyIntoCollection({
        cloneEl: clone,
        startRect,
        applyRect: (el, r) => {
          el.style.left = r.left + 'px';
          el.style.top = r.top + 'px';
          if (r.fontSize) el.style.fontSize = r.fontSize;
        },
        transitionCss: 'left 0.4s ease, top 0.4s ease, font-size 0.4s ease',
        getTargetRect: (labelRect) => getTextCornerRect(labelRect),
        onOpenCollection: () => user && onOpenProfile && onOpenProfile(user.username),
      });
    } finally {
      followAnimationRunning = false;
    }
  }

  pullBtn.addEventListener('click', async () => {
    const user = getCurrentUser();
    if (!user) {
      onNeedsLogin();
      return;
    }
    if (!currentProfile) return;

    if (currentlyFollowing) {
      const ok = await unfollow(user.id, currentProfile.id);
      if (ok) {
        currentlyFollowing = false;
        updatePullLabel();
        showMessage('collection dropped');
      } else {
        flashMessage('error: could not drop');
      }
    } else {
      const ok = await follow(user.id, currentProfile.id);
      if (ok) {
        currentlyFollowing = true;
        updatePullLabel();
        showMessage('added to collection');
        animateFollowIntoGallery(currentProfile.username);
      } else {
        flashMessage('error: could not collect');
      }
    }
  });

  // Für Fenstergrößenänderungen: Textelemente neu anordnen und die Galerie
  // an die neue Breite anpassen (Bildgrößen bleiben unverändert).
  function reflow() {
    if (overlay.style.display !== 'block') return;
    positionWords();
    if (gallery) gallery.relayout();
  }

  return { open, close, repositionWords: positionWords, reflow };
}

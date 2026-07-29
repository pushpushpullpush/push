import { createGallery } from './gallery.js';
import {
  fetchProfileByUsername, fetchUserImages, fetchFollowing,
  isFollowing, follow, unfollow,
} from './profile-data.js';
import { randomSpot, clampToViewport } from './position-utils.js';
import { repositionClock } from './clock.js';
import { repositionShootWord } from './shoot.js';
import { flashMessage } from './feedback.js';

export function initForeignProfile(refs, getCurrentUser, onOpenSingle, onOpenProfile, onNeedsLogin) {
  const { overlay, stage, usernameEl, searchEl, zEl, aEl, escBtn, pullBtn } = refs;

  let gallery = null;
  let currentProfile = null; // { id, username }
  let currentlyFollowing = false;

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

  async function refreshFollowState() {
    const user = getCurrentUser();
    if (!user || !currentProfile) {
      pullBtn.textContent = 'pull';
      currentlyFollowing = false;
      return;
    }
    currentlyFollowing = await isFollowing(user.id, currentProfile.id);
    pullBtn.textContent = currentlyFollowing ? 'release' : 'pull';
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

    await loadGallery(profile);

    searchEl.value = '';
    searchEl.placeholder = 'search';

    await refreshFollowState();
    positionWords();
  }

  function close() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    currentProfile = null;
  }

  escBtn.addEventListener('click', close);
  aEl.addEventListener('click', async () => {
    if (!currentProfile || !gallery) return;
    const images = await fetchUserImages(currentProfile.id);
    gallery.syncImages(images);
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
      searchEl.placeholder = 'search';
      searchEl.blur();
      gallery && gallery.filterByTag('');
    } else if (e.key === 'Enter') {
      searchEl.blur();
    }
  });
  searchEl.addEventListener('blur', () => {
    if (searchEl.value.trim() === '') searchEl.placeholder = 'search';
  });

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
        pullBtn.textContent = 'pull';
      } else {
        flashMessage('error: could not release');
      }
    } else {
      const ok = await follow(user.id, currentProfile.id);
      if (ok) {
        currentlyFollowing = true;
        pullBtn.textContent = 'release';
      } else {
        flashMessage('error: could not pull');
      }
    }
  });

  return { open, close, repositionWords: positionWords };
}

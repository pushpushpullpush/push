import { supabase } from './supabase-client.js';
import { createGallery } from './gallery.js';
import { fetchUserImages, fetchFollowing } from './profile-data.js';
import { randomSpot, clampToViewport } from './position-utils.js';
import { repositionClock } from './clock.js';
import { repositionShootWord, setShootWordVisible } from './shoot.js';
import { flashMessage } from './feedback.js';

export function initOwnGallery(refs, getCurrentUser, onOpenSingle, onOpenProfile) {
  const {
    overlay, stage,
    usernameEl, searchEl, zEl, aEl, escBtn,
    logoutEl, editEl, newsletterToggle, newsletterLine,
    editUsernameLabel, editUsernameInput, editUsernameConfirm,
    editEmailLabel, editEmailInput, editEmailConfirm,
    editPasswordLabel, editPasswordInput, editPasswordConfirm,
    editDeleteLabel, editDeleteInput, editDeleteConfirm,
    editSuccessEl, editByebyeEl, editErrorEl,
  } = refs;

  let gallery = null;
  let mode = 'gallery'; // 'gallery' | 'settings' | 'edit'

  // ─────────────────────────────────────────────
  // Positionierung
  // ─────────────────────────────────────────────
  function positionGalleryWords() {
    const taken = [];
    [usernameEl, searchEl, zEl, aEl, escBtn].forEach((el) => {
      const spot = randomSpot(taken, { margin: 60 });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
    repositionClock(taken);
    repositionShootWord(taken);
  }

  function positionSettingsWords() {
    const taken = [];
    [escBtn, logoutEl, editEl, newsletterLine].forEach((el) => {
      const spot = randomSpot(taken, { margin: 70, minDist: 130 });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
    repositionClock(taken);
  }

  function positionEditWords() {
    const taken = [];
    [escBtn, editUsernameLabel, editEmailLabel, editPasswordLabel, editDeleteLabel].forEach((el) => {
      const spot = randomSpot(taken, { margin: 70, minDist: 130 });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
    repositionClock(taken);
  }

  function positionBelow(el, refEl, offset = 8) {
    const rect = refEl.getBoundingClientRect();
    el.style.left = rect.left + 'px';
    el.style.top = rect.bottom + offset + 'px';
    clampToViewport(el);
  }

  function flashSuccessNear(refEl) {
    positionBelow(editSuccessEl, refEl);
    editSuccessEl.style.display = 'block';
    setTimeout(() => { editSuccessEl.style.display = 'none'; }, 1500);
  }

  function showEditError(text, nearEl) {
    editErrorEl.textContent = text;
    if (nearEl) positionBelow(editErrorEl, nearEl);
    editErrorEl.style.display = 'block';
    setTimeout(() => { editErrorEl.style.display = 'none'; }, 2200);
  }

  // ─────────────────────────────────────────────
  // Ein aufklappbares Feld: Label -> Eingabefeld -> "confirm" (nur bei Änderung)
  // Immer nur eins gleichzeitig offen; zweiter Klick auf dasselbe Label schließt wieder.
  // ─────────────────────────────────────────────
  let currentlyOpenCollapse = null;

  function setupExpandableField(labelEl, inputEl, confirmEl, getOriginalValue, onConfirm) {
    let originalValue = '';
    let isOpenNow = false;

    function collapse() {
      inputEl.style.display = 'none';
      confirmEl.style.display = 'none';
      isOpenNow = false;
      if (currentlyOpenCollapse === collapse) currentlyOpenCollapse = null;
    }

    function expand() {
      if (currentlyOpenCollapse && currentlyOpenCollapse !== collapse) currentlyOpenCollapse();
      originalValue = getOriginalValue();
      inputEl.value = originalValue;
      inputEl.style.display = 'block';
      positionBelow(inputEl, labelEl);
      confirmEl.style.display = 'none';
      isOpenNow = true;
      currentlyOpenCollapse = collapse;
      requestAnimationFrame(() => inputEl.focus());
    }

    labelEl.addEventListener('click', () => {
      if (isOpenNow) collapse();
      else expand();
    });

    inputEl.addEventListener('input', () => {
      const changed = inputEl.value !== originalValue;
      confirmEl.style.display = changed ? 'block' : 'none';
      if (changed) positionBelow(confirmEl, inputEl);
    });

    confirmEl.addEventListener('click', async () => {
      const ok = await onConfirm(inputEl.value.trim());
      if (ok) {
        collapse();
        flashSuccessNear(labelEl);
      }
    });

    return { collapse };
  }

  const usernameField = setupExpandableField(
    editUsernameLabel, editUsernameInput, editUsernameConfirm,
    () => getCurrentUser().username,
    async (rawVal) => {
      const newVal = rawVal.toLowerCase();
      if (!/^[a-z0-9]{2,12}$/.test(newVal)) {
        showEditError('error: 2–12 letters/numbers', editUsernameInput);
        return false;
      }
      const user = getCurrentUser();
      const { error } = await supabase.from('profiles').update({ username: newVal }).eq('id', user.id);
      if (error) {
        const msg = (error.message || '').toLowerCase();
        showEditError(msg.includes('duplicate') || msg.includes('unique') ? 'username taken' : 'error: update failed', editUsernameInput);
        return false;
      }
      user.username = newVal; // teilt sich mit auth.js, da dieselbe Objekt-Referenz
      usernameEl.textContent = newVal;
      return true;
    },
  );

  const emailField = setupExpandableField(
    editEmailLabel, editEmailInput, editEmailConfirm,
    () => '',
    async (newVal) => {
      if (!newVal.includes('@') || !newVal.includes('.')) {
        showEditError('error: invalid e-mail', editEmailInput);
        return false;
      }
      const { error } = await supabase.auth.updateUser({ email: newVal });
      if (error) {
        showEditError('error: update failed', editEmailInput);
        return false;
      }
      return true;
    },
  );

  const passwordField = setupExpandableField(
    editPasswordLabel, editPasswordInput, editPasswordConfirm,
    () => '',
    async (newVal) => {
      if (!newVal) return false;
      const { error } = await supabase.auth.updateUser({ password: newVal });
      if (error) {
        const msg = (error.message || '').toLowerCase();
        showEditError(msg.includes('password') ? 'error: password too short' : 'error: update failed', editPasswordInput);
        return false;
      }
      return true;
    },
  );

  let deleteOpenNow = false;

  function collapseDelete() {
    editDeleteInput.style.display = 'none';
    editDeleteConfirm.style.display = 'none';
    deleteOpenNow = false;
    if (currentlyOpenCollapse === collapseDelete) currentlyOpenCollapse = null;
  }

  editDeleteLabel.addEventListener('click', () => {
    if (deleteOpenNow) {
      collapseDelete();
      return;
    }
    if (currentlyOpenCollapse) currentlyOpenCollapse();
    editDeleteInput.value = '';
    editDeleteInput.style.display = 'block';
    editDeleteConfirm.style.display = 'none';
    positionBelow(editDeleteInput, editDeleteLabel);
    deleteOpenNow = true;
    currentlyOpenCollapse = collapseDelete;
    requestAnimationFrame(() => editDeleteInput.focus());
  });

  editDeleteInput.addEventListener('input', () => {
    const matches = editDeleteInput.value.trim().toLowerCase() === 'delete';
    editDeleteConfirm.style.display = matches ? 'block' : 'none';
    if (matches) positionBelow(editDeleteConfirm, editDeleteInput);
  });

  editDeleteConfirm.addEventListener('click', async () => {
    editDeleteInput.style.display = 'none';
    editDeleteConfirm.style.display = 'none';

    const { error } = await supabase.rpc('delete_own_account');
    if (error) {
      console.error('Konto löschen fehlgeschlagen:', error);
      flashMessage('error: could not delete account');
      return;
    }
    await supabase.auth.signOut();
    editByebyeEl.textContent = 'bye bye';
    positionBelow(editByebyeEl, editDeleteLabel);
    editByebyeEl.style.display = 'block';
    setTimeout(() => window.location.reload(), 1500);
  });

  function collapseAllEditFields() {
    usernameField.collapse();
    emailField.collapse();
    passwordField.collapse();
    collapseDelete();
    editSuccessEl.style.display = 'none';
    editErrorEl.style.display = 'none';
    editByebyeEl.style.display = 'none';
  }

  // ─────────────────────────────────────────────
  // Modi
  // ─────────────────────────────────────────────
  function hideAllSections() {
    stage.style.display = 'none';
    usernameEl.style.display = 'none';
    searchEl.style.display = 'none';
    zEl.style.display = 'none';
    aEl.style.display = 'none';
    logoutEl.style.display = 'none';
    editEl.style.display = 'none';
    newsletterLine.style.display = 'none';
    editUsernameLabel.style.display = 'none';
    editEmailLabel.style.display = 'none';
    editPasswordLabel.style.display = 'none';
    editDeleteLabel.style.display = 'none';
    collapseAllEditFields();
  }

  function enterGallery() {
    mode = 'gallery';
    hideAllSections();
    stage.style.display = 'block';
    usernameEl.style.display = 'block';
    searchEl.style.display = 'block';
    zEl.style.display = 'block';
    aEl.style.display = 'block';
    setShootWordVisible(true);
    positionGalleryWords();
  }

  function enterSettings() {
    mode = 'settings';
    hideAllSections();
    setShootWordVisible(false);
    logoutEl.style.display = 'block';
    editEl.style.display = 'block';
    newsletterLine.style.display = 'block';
    const user = getCurrentUser();
    if (user) newsletterToggle.checked = !!user.newsletter_opt_in;
    positionSettingsWords();
  }

  function enterEdit() {
    mode = 'edit';
    hideAllSections();
    setShootWordVisible(false);
    editUsernameLabel.style.display = 'block';
    editEmailLabel.style.display = 'block';
    editPasswordLabel.style.display = 'block';
    editDeleteLabel.style.display = 'block';
    positionEditWords();
  }

  usernameEl.addEventListener('click', () => {
    if (mode === 'gallery') enterSettings();
  });

  escBtn.addEventListener('click', () => {
    if (mode === 'edit') enterSettings();
    else if (mode === 'settings') enterGallery();
    else close();
  });

  editEl.addEventListener('click', () => enterEdit());

  async function loadGallery(user) {
    stage.innerHTML = '';
    const images = await fetchUserImages(user.id);
    gallery = createGallery(stage, images, {
      onImageClick: (img) => onOpenSingle(img.id, gallery.getVisibleImages()),
    });

    const following = await fetchFollowing(user.id);
    following.forEach((username) => {
      gallery.addUsernameChip(username, (u) => onOpenProfile(u));
    });
  }

  async function open() {
    const user = getCurrentUser();
    if (!user) return;

    usernameEl.textContent = user.username;
    overlay.style.display = 'block';
    document.body.style.overflow = 'hidden';

    await loadGallery(user);

    searchEl.value = '';
    searchEl.placeholder = 'search';

    enterGallery();
  }

  function close() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    mode = 'gallery';
  }

  function removeImageIfPresent(imageId) {
    if (!gallery) return;
    const el = gallery.elements.get(imageId);
    if (el) {
      el.remove();
      gallery.elements.delete(imageId);
    }
  }

  zEl.addEventListener('click', () => {
    if (!gallery) return;
    const images = gallery.getVisibleImages();
    if (!images.length) return;
    const pick = images[Math.floor(Math.random() * images.length)];
    onOpenSingle(pick.id, images);
  });

  aEl.addEventListener('click', async () => {
    const user = getCurrentUser();
    if (!user || !gallery) return;
    const images = await fetchUserImages(user.id);
    gallery.syncImages(images);
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

  logoutEl.addEventListener('click', async () => {
    await supabase.auth.signOut();
    close();
    window.location.reload();
  });

  newsletterToggle.addEventListener('change', async () => {
    const user = getCurrentUser();
    if (!user) return;
    const { error } = await supabase
      .from('profiles')
      .update({ newsletter_opt_in: newsletterToggle.checked })
      .eq('id', user.id);
    if (error) {
      console.error('Newsletter-Einstellung speichern fehlgeschlagen:', error);
      flashMessage('error: could not save preference');
    } else {
      user.newsletter_opt_in = newsletterToggle.checked;
    }
  });

  return { open, close, removeImageIfPresent, repositionWords: positionGalleryWords };
}

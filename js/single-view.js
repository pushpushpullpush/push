import { supabase } from './supabase-client.js';
import { fetchPullersForImage } from './profile-data.js';
import { randomSpot, clampToViewport, computeContainRect } from './position-utils.js';
import { createHeightmap, placeImage } from './layout-engine.js';
import { repositionClock } from './clock.js';
import { repositionShootWord } from './shoot.js';
import { flashTip } from './tips.js';
import { flashMessage } from './feedback.js';

const CHAR_LIMIT = 37;

export function initSingleView(refs, getImages, getCurrentUser, onNeedsLogin, onPullToggled, onOpenProfile) {
  const {
    overlay, imageEl, escBtn, zBtn, pullBtn, commentBtn, reportBtn,
    commentsLayer, dimEsc, typeInput, submitBtn, thanksEl,
  } = refs;

  let currentImage = null;
  let currentImageRect = null;
  let currentContextImages = null; // welche Liste "z" gerade durchsucht
  let isPulled = false;
  let mode = 'view'; // 'view' | 'comment' | 'report'
  let commentsHeightmap = createHeightmap();
  const COMMENT_CHIP_HEIGHT = 32;

  function resetCommentsStage() {
    commentsLayer.innerHTML = '';
    commentsHeightmap = createHeightmap();
    // Bühne beginnt exakt unterhalb des Bildes — beim ersten Laden ist
    // dadurch garantiert nichts vom Bild verdeckt.
    commentsLayer.style.marginTop = (currentImageRect.bottom + 30) + 'px';
    commentsLayer.style.minHeight = '0px';
  }

  function updateCommentsStageHeight() {
    const tallest = Math.max(...commentsHeightmap);
    commentsLayer.style.minHeight = (tallest + 40) + 'px';
  }

  function placeChip(el, width) {
    const stageWidth = commentsLayer.clientWidth || window.innerWidth;
    const pos = placeImage({ width, height: COMMENT_CHIP_HEIGHT }, commentsHeightmap, stageWidth);
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    updateCommentsStageHeight();
  }

  async function loadComments(imageId) {
    const { data, error } = await supabase
      .from('comments')
      .select('id, body, user_id')
      .eq('image_id', imageId)
      .eq('report_hidden', false)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      console.error('Kommentare laden fehlgeschlagen:', error);
      flashMessage('error: could not load comments');
      return;
    }
    (data || []).reverse().forEach((c) => addCommentToLayer(c));
  }

  function showDeleteConfirm(el, comment) {
    const originalText = el.textContent;

    el.innerHTML = '';
    el.style.cursor = 'default';

    const deleteWord = document.createElement('span');
    deleteWord.textContent = 'delete';
    deleteWord.style.cursor = 'pointer';
    deleteWord.style.marginRight = '10px';

    const escWord = document.createElement('span');
    escWord.textContent = 'esc';
    escWord.style.cursor = 'pointer';

    el.appendChild(deleteWord);
    el.appendChild(escWord);

    escWord.addEventListener('click', (e) => {
      e.stopPropagation();
      el.innerHTML = '';
      el.textContent = originalText;
      el.style.cursor = 'pointer';
    });

    deleteWord.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { error } = await supabase.from('comments').delete().eq('id', comment.id);
      if (error) {
        console.error('Kommentar löschen fehlgeschlagen:', error);
        flashMessage('error: could not delete');
        return;
      }
      el.remove();
    });
  }

  function addCommentToLayer(comment) {
    const el = document.createElement('div');
    el.className = 'tag-chip'; // gleiche gelb-kursive Optik wie die Tags
    el.style.position = 'absolute';
    el.textContent = comment.body;
    commentsLayer.appendChild(el);
    placeChip(el, Math.max(90, comment.body.length * 8 + 20));

    const user = getCurrentUser();
    const isMine = user && comment.user_id === user.id;
    if (isMine) {
      el.style.cursor = 'pointer';
      el.style.pointerEvents = 'auto'; // Container hat pointer-events:none, hier gezielt aufheben
      el.addEventListener('click', () => showDeleteConfirm(el, comment));
    }
  }

  function addPullerChip(username) {
    const el = document.createElement('div');
    el.className = 'username-color';
    el.style.position = 'absolute';
    el.style.fontSize = '16px';
    el.style.cursor = 'pointer';
    el.style.pointerEvents = 'auto'; // Container hat pointer-events:none
    el.textContent = username;
    el.addEventListener('click', () => {
      close();
      onOpenProfile && onOpenProfile(username);
    });
    commentsLayer.appendChild(el);
    placeChip(el, Math.max(90, username.length * 9 + 20));
  }

  async function loadPullers(imageId) {
    const pullers = await fetchPullersForImage(imageId);
    pullers.forEach((username) => addPullerChip(username));
  }

  let actionWordSpots = [];

  function positionActionWords() {
    const taken = [];
    [escBtn, zBtn, pullBtn, commentBtn, reportBtn].forEach((el) => {
      const spot = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
    actionWordSpots = taken;
    repositionClock(taken, currentImageRect);
    repositionShootWord(taken, currentImageRect);
  }

  async function refreshPullState() {
    const user = getCurrentUser();
    if (!user || !currentImage) {
      isPulled = false;
      pullBtn.textContent = 'pull';
      return;
    }
    const { data } = await supabase
      .from('pulls')
      .select('id')
      .eq('user_id', user.id)
      .eq('image_id', currentImage.id)
      .maybeSingle();
    isPulled = !!data;
    pullBtn.textContent = isPulled ? 'release' : 'pull';
  }

  async function open(imageId, imagesList) {
    if (imagesList) currentContextImages = imagesList;
    const images = currentContextImages || getImages();
    const img = images.find((i) => i.id === imageId);
    if (!img) return;

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
    positionActionWords();
    resetCommentsStage();
    await refreshPullState();
    await loadComments(img.id);
    await loadPullers(img.id);
  }

  function close() {
    overlay.style.display = 'none';
    currentImage = null;
    currentImageRect = null;
    currentContextImages = null;
    mode = 'view';

    const ownOpen = document.getElementById('own-gallery-view').style.display === 'block';
    const foreignOpen = document.getElementById('foreign-profile-view').style.display === 'block';
    if (!ownOpen && !foreignOpen) {
      document.body.style.overflow = '';
    }
  }

  function showRandom() {
    const images = currentContextImages || getImages();
    if (!images.length) return;
    const pick = images[Math.floor(Math.random() * images.length)];
    open(pick.id);
  }

  escBtn.addEventListener('click', close);
  zBtn.addEventListener('click', showRandom);

  pullBtn.addEventListener('click', async () => {
    const user = getCurrentUser();
    if (!user) {
      onNeedsLogin();
      return;
    }
    if (!currentImage) return;

    if (isPulled) {
      const { error } = await supabase
        .from('pulls')
        .delete()
        .eq('user_id', user.id)
        .eq('image_id', currentImage.id);
      if (error) {
        console.error('Shove fehlgeschlagen:', error);
        flashMessage('error: could not release');
        return;
      }
      isPulled = false;
      pullBtn.textContent = 'pull';
      [...commentsLayer.querySelectorAll('.username-color')]
        .filter((el) => el.textContent === user.username)
        .forEach((el) => el.remove());
    } else {
      const { error } = await supabase
        .from('pulls')
        .insert({ user_id: user.id, image_id: currentImage.id });
      if (error) {
        console.error('Pull fehlgeschlagen:', error);
        flashMessage('error: could not pull');
        return;
      }
      isPulled = true;
      pullBtn.textContent = 'release';
      addPullerChip(user.username);
    }

    if (onPullToggled) onPullToggled(currentImage.id, isPulled);
  });

  function enterMode(newMode) {
    mode = newMode;
    const dim = mode !== 'view';

    [imageEl, escBtn, zBtn, pullBtn, commentBtn, reportBtn].forEach((el) => {
      el.style.opacity = dim ? '0.2' : '1';
      el.style.pointerEvents = dim ? 'none' : 'auto';
    });
    commentsLayer.style.opacity = dim ? '0.2' : '1';

    dimEsc.style.display = dim ? 'block' : 'none';
    typeInput.style.display = dim ? 'block' : 'none';
    submitBtn.style.display = dim ? 'block' : 'none';
    thanksEl.style.display = 'none';

    if (dim) {
      typeInput.value = '';
      typeInput.placeholder = 'type';
      typeInput.maxLength = CHAR_LIMIT;
      typeInput.classList.toggle('field-yellow', mode === 'comment');
      submitBtn.textContent = mode;

      const taken = [];

      const spotEsc = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spotEsc);
      dimEsc.style.left = spotEsc.x + 'px';
      dimEsc.style.top = spotEsc.y + 'px';
      clampToViewport(dimEsc);

      const spotType = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spotType);
      typeInput.style.left = spotType.x + 'px';
      typeInput.style.top = spotType.y + 'px';
      clampToViewport(typeInput);

      const spotSubmit = randomSpot(taken, {
        margin: 60,
        avoidRect: currentImageRect,
        yRange: [0.6, 0.85],
      });
      taken.push(spotSubmit);
      submitBtn.style.left = spotSubmit.x + 'px';
      submitBtn.style.top = spotSubmit.y + 'px';
      clampToViewport(submitBtn);

      repositionClock(taken, currentImageRect);

      requestAnimationFrame(() => typeInput.focus());
    }
  }

  commentBtn.addEventListener('click', () => {
    if (!getCurrentUser()) {
      onNeedsLogin();
      return;
    }
    enterMode('comment');
  });
  reportBtn.addEventListener('click', () => {
    if (!getCurrentUser()) {
      onNeedsLogin();
      return;
    }
    enterMode('report');
  });
  dimEsc.addEventListener('click', () => enterMode('view'));

  let isSubmitting = false;

  function flashThanks(text) {
    thanksEl.textContent = text;
    thanksEl.style.display = 'block';
    thanksEl.style.transform = 'none';
    const spot = randomSpot([], { margin: 60, avoidRect: currentImageRect });
    thanksEl.style.left = spot.x + 'px';
    thanksEl.style.top = spot.y + 'px';
    clampToViewport(thanksEl);
  }

  async function submit() {
    const val = typeInput.value.trim();
    const user = getCurrentUser();
    if (!val || !currentImage || isSubmitting || !user) return;

    isSubmitting = true;
    submitBtn.style.pointerEvents = 'none';
    submitBtn.style.opacity = '0.3';

    try {
      if (mode === 'comment') {
        const { data: inserted, error } = await supabase
          .from('comments')
          .insert({ image_id: currentImage.id, body: val, user_id: user.id })
          .select()
          .single();

        if (error) {
          console.error('Kommentar fehlgeschlagen:', error);
          flashMessage('error: comment failed');
          return;
        }
        addCommentToLayer(inserted);
        enterMode('view');
        flashTip();
      } else if (mode === 'report') {
        const { error } = await supabase
          .from('reports')
          .insert({ target_type: 'image', target_id: currentImage.id, reason: val });

        if (error) {
          console.error('Report fehlgeschlagen:', error);
          flashMessage('error: report failed');
          return;
        }
        typeInput.style.display = 'none';
        submitBtn.style.display = 'none';
        enterMode('view');
        flashTip();
      }
    } finally {
      isSubmitting = false;
      submitBtn.style.pointerEvents = 'auto';
      submitBtn.style.opacity = '1';
    }
  }

  // Kommentare: Klick ODER Enter bestätigt. Reports bewusst nur per Klick —
  // höhere Hürde, da nicht rückgängig machbar.
  submitBtn.addEventListener('click', submit);
  typeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && mode === 'comment') submit();
  });

  return { open, showRandom };
}

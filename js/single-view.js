import { supabase } from './supabase-client.js';
import { fetchPullersForImage } from './profile-data.js';
import { randomSpot, clampToViewport, clampFromRect, computeContainRect } from './position-utils.js';
import { createHeightmap, placeImage } from './layout-engine.js';
import { repositionClock, setClockVisible } from './clock.js';
import { repositionShootWord, setShootWordVisible } from './shoot.js';
import { flashMessage } from './feedback.js';
import { showMessage, showRandomHint } from './notice-board.js';
import { flyIntoOwnGallery } from './pull-animation.js';

const CHAR_LIMIT = 37;

// Sicherheitsabstand der frei platzierten Textelemente zur Bildfläche
// bzw. zum Bildschirmrand — großzügiger als der allgemeine Default,
// damit in der Einzelansicht nichts ins Bild hineinragt.
const IMAGE_SAFETY_PAD = 40;
const EDGE_SAFETY_PAD = 32;

export function initSingleView(refs, getImages, getCurrentUser, onNeedsLogin, onPullToggled, onOpenProfile, getOwnGallery) {
  const {
    overlay, imageEl, escBtn, zBtn, pullBtn, commentBtn, reportBtn, viewsEl,
    commentsLayer, dimEsc, typeInput, submitBtn, thanksEl,
  } = refs;

  let currentImage = null;
  let currentImageRect = null;
  let currentContextImages = null; // welche Liste "z" gerade durchsucht
  let isPulled = false;
  let mode = 'view'; // 'view' | 'comment' | 'report'
  let commentsHeightmap = createHeightmap();
  const COMMENT_CHIP_HEIGHT = 32;
  let viewsChannel = null;

  // Globaler Klick-Zähler: erhöht sich atomar serverseitig bei jedem
  // Öffnen der Einzelansicht, Live-Update per Realtime, falls parallel
  // jemand anderes dasselbe Bild ansieht.
  function unsubscribeViews() {
    if (viewsChannel) {
      supabase.removeChannel(viewsChannel);
      viewsChannel = null;
    }
  }

  async function trackView(imageId) {
    unsubscribeViews();

    const { data, error } = await supabase.rpc('increment_image_views', { p_image_id: imageId });
    if (error) {
      console.error('View-Zähler fehlgeschlagen:', error);
    } else if (typeof data === 'number') {
      viewsEl.textContent = `views: ${data}`;
      // Der Text kommt erst asynchron nach dem Positionieren an und kann
      // dadurch breiter werden als angenommen — noch einmal korrigieren.
      correctElementForImage(viewsEl);
    }

    viewsChannel = supabase
      .channel(`image-views-${imageId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'images', filter: `id=eq.${imageId}`,
      }, (payload) => {
        if (typeof payload.new.views === 'number') {
          viewsEl.textContent = `views: ${payload.new.views}`;
          correctElementForImage(viewsEl);
        }
      })
      .subscribe();
  }

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
    escWord.textContent = 'b';
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

  // Schiebt ein bereits positioniertes Element notfalls vom aktuellen Bild
  // weg — ohne es komplett neu zu würfeln. Genutzt, wenn die Position
  // eigentlich gehalten werden soll (z.B. beim Bildwechsel per [z], oder
  // wenn der views-Text erst nachträglich breiter wird als angenommen).
  function correctElementForImage(el) {
    const reportRect = reportBtn.getBoundingClientRect();
    clampFromRect(el, currentImageRect, IMAGE_SAFETY_PAD);
    clampFromRect(el, reportRect, 20);
    clampToViewport(el, EDGE_SAFETY_PAD);
  }

  function correctPositionsForImage() {
    [escBtn, zBtn, pullBtn, commentBtn, viewsEl].forEach(correctElementForImage);
    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
    const shootEl = document.getElementById('shoot-word');
    if (shootEl) correctElementForImage(shootEl);
  }

  function positionActionWords() {
    const taken = [];

    // reportBtn ist fest unten rechts verankert (siehe CSS) und wird hier
    // nicht mehr zufällig platziert — andere Textelemente weichen ihm
    // trotzdem weiterhin aus, damit nichts überlappt.
    const reportRect = reportBtn.getBoundingClientRect();
    taken.push({ x: reportRect.left, y: reportRect.top });

    [escBtn, zBtn, pullBtn, commentBtn, viewsEl].forEach((el) => {
      const spot = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      correctElementForImage(el);
    });
    actionWordSpots = taken;
    repositionClock(taken, currentImageRect);
    repositionShootWord(taken, currentImageRect);

    const clockEl = document.getElementById('global-clock');
    if (clockEl) correctElementForImage(clockEl);
    const shootEl = document.getElementById('shoot-word');
    if (shootEl) correctElementForImage(shootEl);
  }

  // "release" (schon gepullt) erscheint kleiner, in Uhrzeit-Schriftgröße —
  // "pull" (noch nicht gepullt) bleibt normal groß.
  function updatePullButtonStyle() {
    pullBtn.textContent = isPulled ? 'release' : 'pull';
    pullBtn.style.fontSize = isPulled ? '16px' : '';
  }

  async function refreshPullState() {
    const user = getCurrentUser();
    if (!user || !currentImage) {
      isPulled = false;
      updatePullButtonStyle();
      return;
    }
    const { data } = await supabase
      .from('pulls')
      .select('id')
      .eq('user_id', user.id)
      .eq('image_id', currentImage.id)
      .maybeSingle();
    isPulled = !!data;
    updatePullButtonStyle();
  }

  async function open(imageId, imagesList) {
    if (imagesList) currentContextImages = imagesList;
    const images = currentContextImages || getImages();
    const img = images.find((i) => i.id === imageId);
    if (!img) return;

    // Nur ein frischer Einstieg aus der Galerie bekommt eine neue zufällige
    // Anordnung der Textelemente — solange man (z.B. über mehrfaches [z])
    // in der Einzelansicht bleibt, halten sie ihre Position.
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
    if (!wasAlreadyOpen) {
      positionActionWords();
    } else {
      // Position halten (siehe [z]-Verhalten), aber vor Überlappung mit dem
      // neuen — möglicherweise anders geformten — Bild schützen.
      correctPositionsForImage();
    }
    resetCommentsStage();
    await refreshPullState();
    await loadComments(img.id);
    await loadPullers(img.id);
    trackView(img.id);
  }

  function close() {
    overlay.style.display = 'none';
    unsubscribeViews();
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

  let pullAnimationRunning = false;

  async function animatePullImage(imageId) {
    if (pullAnimationRunning) return;
    const ownGallery = getOwnGallery && getOwnGallery();
    if (!ownGallery) return;

    pullAnimationRunning = true;
    try {
      const startRect = imageEl.getBoundingClientRect();
      const clone = document.createElement('img');
      clone.src = imageEl.src;
      clone.style.objectFit = 'contain';

      await flyIntoOwnGallery({
        cloneEl: clone,
        sourceEl: imageEl,
        startRect,
        applyRect: (el, r) => {
          el.style.left = r.left + 'px';
          el.style.top = r.top + 'px';
          el.style.width = r.width + 'px';
          el.style.height = r.height + 'px';
        },
        transitionCss: 'left 0.4s ease, top 0.4s ease, width 0.4s ease, height 0.4s ease',
        ownGallery,
        getTargetRect: () => ownGallery.getImageRect(imageId),
      });
    } finally {
      pullAnimationRunning = false;
    }
  }

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
      updatePullButtonStyle();
      showMessage('image released');
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
      updatePullButtonStyle();
      showMessage('image pulled');
      addPullerChip(user.username);
      animatePullImage(currentImage.id);
    }

    if (onPullToggled) onPullToggled(currentImage.id, isPulled);
  });

  function enterMode(newMode) {
    mode = newMode;
    const dim = mode !== 'view';

    [imageEl, escBtn, zBtn, pullBtn, commentBtn, reportBtn, viewsEl].forEach((el) => {
      el.style.opacity = dim ? '0.2' : '1';
      el.style.pointerEvents = dim ? 'none' : 'auto';
    });
    commentsLayer.style.opacity = dim ? '0.2' : '1';
    setShootWordVisible(!dim);

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
      clampFromRect(dimEsc, currentImageRect, IMAGE_SAFETY_PAD);
      clampToViewport(dimEsc, EDGE_SAFETY_PAD);

      const spotType = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
      taken.push(spotType);
      typeInput.style.left = spotType.x + 'px';
      typeInput.style.top = spotType.y + 'px';
      clampFromRect(typeInput, currentImageRect, IMAGE_SAFETY_PAD);
      clampToViewport(typeInput, EDGE_SAFETY_PAD);

      const spotSubmit = randomSpot(taken, {
        margin: 60,
        avoidRect: currentImageRect,
        yRange: [0.6, 0.85],
      });
      taken.push(spotSubmit);
      submitBtn.style.left = spotSubmit.x + 'px';
      submitBtn.style.top = spotSubmit.y + 'px';
      clampFromRect(submitBtn, currentImageRect, IMAGE_SAFETY_PAD);
      clampToViewport(submitBtn, EDGE_SAFETY_PAD);

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
    clampFromRect(thanksEl, currentImageRect, IMAGE_SAFETY_PAD);
    clampToViewport(thanksEl, EDGE_SAFETY_PAD);
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
        showRandomHint();
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

  return {
    open,
    showRandom,
    // Für Fenstergrößenänderungen: nur die frei positionierten Textelemente
    // zurück in den sichtbaren Bereich holen — das Bild behält seine
    // ursprüngliche Größe (wird nicht neu berechnet, soll nicht schrumpfen).
    reposition: () => {
      if (overlay.style.display === 'block') positionActionWords();
    },
  };
}

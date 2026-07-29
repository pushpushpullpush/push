import { computeFullLayout, placeImage, createHeightmap } from './layout-engine.js';

export function createGallery(stageEl, initialImages, { onImageClick } = {}) {
  const els = new Map();
  const images = [...initialImages];
  let heightmap = createHeightmap();
  let pushCounter = 1000; // garantiert höher als der normale Zufallsbereich (0–999)

  // Username-Chips müssen VOR dem ersten reshuffleImages()-Aufruf existieren,
  // da dieser sie sofort mit anspricht.
  let usernameChips = []; // { username, width, height, el }

  function makeEl(img) {
    const el = document.createElement(img.url ? 'img' : 'div');
    el.className = 'push-image';
    el.dataset.imageId = img.id;
    el.style.width = img.width + 'px';
    el.style.height = img.height + 'px';
    if (img.url) {
      el.loading = 'lazy';
      el.decoding = 'async';
      el.src = img.url;
    } else {
      el.style.background = img.color;
    }
    if (onImageClick) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => onImageClick(img));
    }
    stageEl.appendChild(el);
    els.set(img.id, el);
    return el;
  }

  images.forEach(makeEl);

  function updateStageHeight() {
    const tallest = Math.max(...heightmap) + 40;
    stageEl.style.minHeight = Math.max(tallest, window.innerHeight) + 'px';
  }

  function placeChip(chip) {
    const width0 = stageEl.clientWidth || 680;
    const pos = placeImage({ width: chip.width, height: chip.height }, heightmap, width0);
    chip.el.style.left = pos.left + 'px';
    chip.el.style.top = pos.top + 'px';
    chip.el.style.zIndex = pos.z;
  }

  function reshuffleImages() {
    const width = stageEl.clientWidth || 680;
    const { positions, heightmap: newHeightmap } = computeFullLayout(images, width);
    heightmap = newHeightmap;
    images.forEach((img) => {
      const el = els.get(img.id);
      const pos = positions.get(img.id);
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      el.style.zIndex = pos.z;
    });
    usernameChips.forEach((chip) => placeChip(chip));
    updateStageHeight();
  }

  reshuffleImages();

  /**
   * Fügt genau ein neu gepushtes Bild hinzu, ohne die bestehende
   * Anordnung aller anderen Bilder anzufassen. Scrollt dorthin,
   * damit die pushende Person ihr Bild direkt sieht.
   */
  function addImage(img) {
    images.push(img);
    const el = makeEl(img);
    const width = stageEl.clientWidth || 680;
    const pos = placeImage(img, heightmap, width);
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    el.style.zIndex = 1000 + (pushCounter++ % 1000); // bleibt zwischen 1000–1999, wächst nie unbegrenzt
    updateStageHeight();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function filterByTag(query) {
    const q = query.trim().toLowerCase();
    images.forEach((img) => {
      const el = els.get(img.id);
      if (!q) {
        el.style.display = '';
        return;
      }
      const matches = (img.tags || []).some((t) => t.toLowerCase().includes(q));
      el.style.display = matches ? '' : 'none';
    });
  }

  function getVisibleImages() {
    return images.filter((img) => {
      const el = els.get(img.id);
      return el && el.style.display !== 'none';
    });
  }

  function addUsernameChip(username, onClick) {
    const width = Math.max(90, username.length * 15 + 20);
    const height = 34;

    const el = document.createElement('div');
    el.className = 'username-color username-chip';
    el.textContent = username;
    el.style.position = 'absolute';
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => onClick(username));
    stageEl.appendChild(el);

    const chip = { username, width, height, el };
    usernameChips.push(chip);
    placeChip(chip);
    updateStageHeight();
    return el;
  }

  function clearUsernameChips() {
    usernameChips.forEach((c) => c.el.remove());
    usernameChips = [];
  }

  function appendImages(newImages) {
    const width = stageEl.clientWidth || 680;
    newImages.forEach((img) => {
      if (els.has(img.id)) return; // schon vorhanden, überspringen
      images.push(img);
      const el = makeEl(img);
      const pos = placeImage(img, heightmap, width);
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      el.style.zIndex = pos.z;
    });
    updateStageHeight();
  }

  function syncImages(newImages) {
    const newIds = new Set(newImages.map((img) => img.id));

    for (let i = images.length - 1; i >= 0; i--) {
      if (!newIds.has(images[i].id)) {
        const el = els.get(images[i].id);
        if (el) el.remove();
        els.delete(images[i].id);
        images.splice(i, 1);
      }
    }

    newImages.forEach((img) => {
      if (!els.has(img.id)) {
        images.push(img);
        makeEl(img);
      }
    });

    reshuffleImages();
  }

  return {
    reshuffleImages,
    addImage,
    appendImages,
    syncImages,
    filterByTag,
    addUsernameChip,
    clearUsernameChips,
    getImages: () => images,
    getVisibleImages,
    elements: els,
  };
}

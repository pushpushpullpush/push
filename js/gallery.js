import { computeFullLayout, placeImage, createHeightmap, computeChronologicalLayout, EDGE_MARGIN } from './layout-engine.js';
import { showMessage } from './notice-board.js';

export function createGallery(stageEl, initialImages, { onImageClick } = {}) {
  const els = new Map();
  const images = [...initialImages];
  let heightmap = createHeightmap(stageEl.clientWidth || 680);

  // 'chronological' (Standard: neueste oben) oder 'random' (Zufalls-Toggle
  // über [a]). images bleibt intern immer chronologisch sortiert (neueste
  // zuerst) — nur die Anzeige wechselt.
  let sortMode = 'chronological';

  // Username-Chips müssen VOR dem ersten reshuffleImages()-Aufruf existieren,
  // da dieser sie sofort mit anspricht.
  let usernameChips = []; // { username, width, height, el }

  // Aktueller Tag-Filter (leer = kein Filter). layoutAll() berücksichtigt
  // das immer, damit z.B. [a] bei aktivem Filter nicht wieder Lücken durch
  // ausgeblendete Bilder aufreißt.
  let currentFilterQuery = '';

  function visibleImagesForFilter() {
    if (!currentFilterQuery) return images;
    return images.filter((img) => (img.tags || []).some((t) => t.toLowerCase().includes(currentFilterQuery)));
  }

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
    const tallest = Math.max(...heightmap) + EDGE_MARGIN;
    stageEl.style.minHeight = Math.max(tallest, window.innerHeight) + 'px';
  }

  function computeLayoutFor(imgList, width) {
    return sortMode === 'random'
      ? computeFullLayout(imgList, width)
      : computeChronologicalLayout(imgList, width);
  }

  function placeChip(chip) {
    const width0 = stageEl.clientWidth || 680;
    const pos = placeImage({ width: chip.width, height: chip.height }, heightmap, width0);
    chip.el.style.left = pos.left + 'px';
    chip.el.style.top = pos.top + 'px';
    chip.el.style.zIndex = pos.z;
  }

  function layoutAll() {
    const width = stageEl.clientWidth || 680;
    const visible = visibleImagesForFilter();
    const visibleIds = new Set(visible.map((img) => img.id));

    images.forEach((img) => {
      els.get(img.id).style.display = visibleIds.has(img.id) ? '' : 'none';
    });

    // Ausgeblendete Bilder sollen keinen Platz belegen — Layout wird nur
    // für die sichtbaren Bilder berechnet, damit sie zusammenrücken statt
    // Lücken zu hinterlassen (gilt für Filter UND [a]-Toggle gleichermaßen).
    const { positions, heightmap: newHeightmap } = computeLayoutFor(visible, width);
    heightmap = newHeightmap;
    visible.forEach((img) => {
      const el = els.get(img.id);
      const pos = positions.get(img.id);
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      el.style.zIndex = pos.z;
    });
    usernameChips.forEach((chip) => placeChip(chip));
    updateStageHeight();
  }

  /**
   * [a]: Toggle zwischen chronologischer und zufälliger Reihenfolge.
   * computeFullLayout mischt bei jedem Aufruf frisch — jeder Wechsel in
   * den Zufallsmodus ergibt daher automatisch eine neue Anordnung. Zeigt
   * kurz oben links ein, in welchem Modus man jetzt ist.
   */
  function reshuffleImages() {
    sortMode = sortMode === 'chronological' ? 'random' : 'chronological';
    layoutAll();
    showMessage(sortMode, 1600);
  }

  layoutAll();

  /**
   * Fügt genau ein neu gepushtes Bild hinzu (immer als neuestes vorn im
   * Datenmodell). Jeder Push schaltet auf chronologische Anzeige um, damit
   * das neue Bild sichtbar oben einsortiert erscheint und alle bestehenden
   * Bilder nach unten rutschen. Scrollt dorthin, damit die pushende Person
   * ihr Bild direkt sieht.
   */
  function addImage(img) {
    images.unshift(img);
    const el = makeEl(img);
    sortMode = 'chronological';
    layoutAll();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function filterByTag(query) {
    currentFilterQuery = query.trim().toLowerCase();
    layoutAll();
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

  /**
   * Ältere Bilder beim Nachladen (Scrollen) — gehören chronologisch ans
   * Ende und werden dort inkrementell platziert, ohne die bestehende
   * Anordnung anzufassen (kein Voll-Relayout nötig).
   */
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
      const matches = !currentFilterQuery || (img.tags || []).some((t) => t.toLowerCase().includes(currentFilterQuery));
      if (!matches) el.style.display = 'none';
    });
    updateStageHeight();
  }

  /**
   * Neue Pushes von anderen Usern (Realtime) — zählen als neueste und
   * kommen vorn in die Reihenfolge. Schaltet wie addImage auf
   * chronologische Anzeige um, damit sie sichtbar oben einsortieren und
   * alles Bestehende nach unten rutscht.
   */
  function prependImages(newImages) {
    const freshImages = newImages.filter((img) => !els.has(img.id));
    if (!freshImages.length) return;

    for (let i = freshImages.length - 1; i >= 0; i--) images.unshift(freshImages[i]);
    freshImages.forEach(makeEl);

    sortMode = 'chronological';
    layoutAll();
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

    layoutAll();
  }

  return {
    reshuffleImages,
    addImage,
    appendImages,
    prependImages,
    syncImages,
    filterByTag,
    addUsernameChip,
    clearUsernameChips,
    getImages: () => images,
    getVisibleImages,
    elements: els,
    // Für Fenstergrößenänderungen: legt die Bilder anhand der aktuellen
    // Breite neu an (gleicher Modus/Filter wie zuvor, keine Umschaltung).
    relayout: layoutAll,
  };
}

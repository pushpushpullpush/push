import { computeFullLayout, placeImage, createHeightmap, computeChronologicalLayout, EDGE_MARGIN } from './layout-engine.js';
import { showMessage } from './notice-board.js';

export function createGallery(stageEl, initialImages, { onImageClick, onSortModeChange, initialSortMode = 'chronological' } = {}) {
  const els = new Map();
  const images = [...initialImages];
  let heightmap = createHeightmap(stageEl.clientWidth || 680);

  // 'chronological' (Startzustand, neueste oben) oder 'random' ([s]-Shuffle).
  // initialSortMode: für Galerien, die von Anfang an im aktuellen Modus der
  // Hauptgalerie starten sollen (siehe "connect"-Auswahl in single-view.js)
  // -- setzt den Modus lautlos, ohne die shuffleRandom()-Meldung auszulösen.
  let sortMode = initialSortMode === 'random' ? 'random' : 'chronological';

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

  function layoutAll() {
    const width = stageEl.clientWidth || 680;
    const { positions, heightmap: newHeightmap } = computeLayoutFor(images, width);
    heightmap = newHeightmap;
    images.forEach((img) => {
      const el = els.get(img.id);
      const pos = positions.get(img.id);
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      el.style.zIndex = pos.z;
    });
    updateStageHeight();
  }

  function notifySortMode() {
    if (onSortModeChange) onSortModeChange(sortMode);
  }

  /**
   * [a]: zurück zur chronologischen Reihenfolge (Startzustand) — no-op,
   * falls bereits chronologisch (computeChronologicalLayout würfelt intern
   * ebenfalls leicht, ein erneuter Aufruf würde sonst unnötig umsortieren).
   */
  function sortChronological() {
    if (sortMode === 'chronological') return;
    sortMode = 'chronological';
    layoutAll();
    showMessage('chronological', 1600);
    notifySortMode();
  }

  /**
   * [s]: zufällige Reihenfolge — computeFullLayout mischt bei jedem Aufruf
   * frisch, daher beliebig oft hintereinander auslösbar, jedes Mal neu.
   */
  function shuffleRandom() {
    sortMode = 'random';
    layoutAll();
    showMessage('random', 1600);
    notifySortMode();
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
    notifySortMode();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    notifySortMode();
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
    sortChronological,
    shuffleRandom,
    addImage,
    appendImages,
    prependImages,
    syncImages,
    getImages: () => images,
    getSortMode: () => sortMode,
    elements: els,
    // Für Fenstergrößenänderungen: legt die Bilder anhand der aktuellen
    // Breite neu an (gleicher Modus wie zuvor, keine Umschaltung).
    relayout: layoutAll,
  };
}

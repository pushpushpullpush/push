import { computeFullLayout, placeImage, createHeightmap, computeChronologicalLayout, EDGE_MARGIN } from './layout-engine.js';
import { showMessage } from './notice-board.js';

export function createGallery(stageEl, initialImages, {
  onImageClick, onSortModeChange, initialSortMode = 'chronological', reservedArea,
  // fillViewport: die Bühne ist mindestens einen vollen Bildschirm hoch,
  // auch bei wenigen Bildern -- sinnvoll für main/connect-view (eigenständige
  // Seiten), aber nicht für eine kompakte Vorschau-Sammlung unter einem
  // Bild (single-view.js), die sonst riesigen leeren Platz erzeugen würde.
  // noOverlap: siehe layout-engine.js/pickDelta -- für die Ansicht einer
  // einzelnen connect-Galerie, deren Bilder sich nie überlappen sollen.
  fillViewport = true, noOverlap = false,
} = {}) {
  const els = new Map();
  const images = [...initialImages];
  let heightmap = createHeightmap(stageEl.clientWidth || 680, reservedArea);

  // 'chronological' (Startzustand, neueste oben) oder 'random' ([s]-Shuffle).
  let sortMode = initialSortMode === 'random' ? 'random' : 'chronological';

  function makeEl(img) {
    const el = document.createElement(img.url ? 'img' : 'div');
    el.className = 'push-image';
    el.dataset.imageId = img.id;
    el.style.width = img.width + 'px';
    el.style.height = img.height + 'px';
    if (img.url) {
      // <img> ist in Chrome standardmäßig per natives HTML5-Drag ziehbar --
      // schon eine winzige Mausbewegung zwischen Drücken und Loslassen (bei
      // echten Nutzenden normal, anders als bei automatisierten Klicks)
      // startet dann einen Drag STATT eines "click", der Klick-Handler
      // unten feuert in dem Fall nie. Betrifft kleine Kacheln (z.B. die
      // Vorschau-Sammlung in single-view.js) besonders, da dort präziseres
      // Zielen nötig ist.
      el.draggable = false;
      // Zusätzlich zu draggable=false: verhindert das native Drag auch dann
      // zuverlässig, wenn ein Browser die draggable-Eigenschaft (als
      // JS-Property statt HTML-Attribut gesetzt) nicht in jedem Fall
      // respektiert -- preventDefault() auf dragstart ist der robusteste,
      // browserübergreifend zuverlässige Weg, natives Bild-Drag zu stoppen.
      el.addEventListener('dragstart', (e) => e.preventDefault());
      el.loading = 'lazy';
      el.decoding = 'async';
      el.src = img.url;
    } else {
      el.style.background = img.color;
    }
    const handler = onImageClick ? () => onImageClick(img) : null;
    if (handler) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', handler);
    }
    stageEl.appendChild(el);
    els.set(img.id, el);
    return el;
  }

  images.forEach(makeEl);

  function updateStageHeight() {
    const tallest = Math.max(...heightmap) + EDGE_MARGIN;
    stageEl.style.minHeight = (fillViewport ? Math.max(tallest, window.innerHeight) : tallest) + 'px';
  }

  function computeLayoutFor(imgList, width) {
    return sortMode === 'random'
      ? computeFullLayout(imgList, width, reservedArea, { noOverlap })
      : computeChronologicalLayout(imgList, width, reservedArea, { noOverlap });
  }

  function applyPosition(img, pos) {
    const el = els.get(img.id);
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    el.style.zIndex = pos.z;
  }

  function layoutAll() {
    const width = stageEl.clientWidth || 680;
    const { positions, heightmap: newHeightmap } = computeLayoutFor(images, width);
    heightmap = newHeightmap;
    images.forEach((img) => applyPosition(img, positions.get(img.id)));
    updateStageHeight();
  }

  function notifySortMode() {
    if (onSortModeChange) onSortModeChange(sortMode);
  }

  /**
   * Klick auf die Uhr (main.js): zurück zur chronologischen Reihenfolge
   * (Startzustand) — no-op, falls bereits chronologisch
   * (computeChronologicalLayout würfelt intern ebenfalls leicht, ein
   * erneuter Aufruf würde sonst unnötig umsortieren).
   */
  function sortChronological() {
    if (sortMode === 'chronological') return;
    sortMode = 'chronological';
    layoutAll();
    showMessage('arrange', 1600);
    notifySortMode();
  }

  /**
   * [s]: zufällige Reihenfolge — computeFullLayout mischt bei jedem Aufruf
   * frisch, daher beliebig oft hintereinander auslösbar, jedes Mal neu.
   */
  function shuffleRandom() {
    sortMode = 'random';
    layoutAll();
    showMessage('shuffle', 1600);
    notifySortMode();
  }

  layoutAll();

  /**
   * Fügt genau ein neu gepushtes Bild hinzu (immer als neuestes vorn im
   * Datenmodell). Jeder Push schaltet auf chronologische Anzeige um, damit
   * das neue Bild sichtbar oben einsortiert erscheint und alle bestehenden
   * Bilder nach unten rutschen. Scrollt dorthin, damit die pushende Person
   * ihr Bild direkt sieht.
   *
   * Prüft wie appendImages/prependImages, ob die ID schon existiert: der
   * Realtime-Kanal (siehe main.js) kann dasselbe neu gepushte Bild bereits
   * über prependImages() eingefügt haben, BEVOR die eigene Insert-Antwort
   * hier ankommt (Wettlauf zwischen REST-Antwort und WebSocket-Meldung,
   * abhängig von Netzwerklatenz) -- ohne diese Prüfung entstand dafür ein
   * zweites, dupliziertes Element; das erste blieb dabei unsichtbar
   * verwaist an seiner ursprünglichen Position stehen, während sich alles
   * andere per CSS-Transition darum herum verschob.
   */
  function addImage(img) {
    if (!els.has(img.id)) {
      images.unshift(img);
      makeEl(img);
      sortMode = 'chronological';
      layoutAll();
      notifySortMode();
    }
    els.get(img.id).scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      makeEl(img);
      const pos = placeImage(img, heightmap, width, reservedArea, Math.random, noOverlap);
      applyPosition(img, pos);
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

  return {
    sortChronological,
    shuffleRandom,
    addImage,
    appendImages,
    prependImages,
    getImages: () => images,
    elements: els,
    // Für Fenstergrößenänderungen: legt die Bilder anhand der aktuellen
    // Breite neu an (gleicher Modus wie zuvor, keine Umschaltung).
    relayout: layoutAll,
  };
}

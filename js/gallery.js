import { computeFullLayout, placeImage, createHeightmap, computeChronologicalLayout, EDGE_MARGIN } from './layout-engine.js';
import { showMessage } from './notice-board.js';

// Zähler unter einem gespeicherten Reihen-Eintrag (siehe series-repo.js,
// img.isSeries) -- Höhe des Zähler-Textes plus Abstand zum Bild darüber.
// Fließt als extraBottom in die Heightmap-Berechnung ein (layout-engine.js),
// damit die Layout-Engine dafür exklusiv Platz freihält.
const SERIES_COUNTER_HEIGHT = 20;
const SERIES_COUNTER_GAP = 6;
const SERIES_EXTRA_BOTTOM = SERIES_COUNTER_HEIGHT + SERIES_COUNTER_GAP;

export function createGallery(stageEl, initialImages, {
  onImageClick, onSeriesClick, onSortModeChange, initialSortMode = 'chronological', reservedArea,
} = {}) {
  const els = new Map();
  const counterEls = new Map(); // nur für Reihen-Einträge (img.isSeries) belegt
  const images = [...initialImages];
  let heightmap = createHeightmap(stageEl.clientWidth || 680, reservedArea);

  // 'chronological' (Startzustand, neueste oben) oder 'random' ([s]-Shuffle).
  // initialSortMode: für Galerien, die von Anfang an im aktuellen Modus der
  // Hauptgalerie starten sollen (siehe "connect"-Auswahl in single-view.js)
  // -- setzt den Modus lautlos, ohne die shuffleRandom()-Meldung auszulösen.
  let sortMode = initialSortMode === 'random' ? 'random' : 'chronological';

  // Reihen-Einträge laufen durch dieselbe Layout-Engine wie normale Bilder
  // (organische Streu-Anordnung, gleiche Flächen-Normierung), brauchen aber
  // zusätzlichen reservierten Platz unter dem Bild für den Zähler -- ein
  // eigenes, um extraBottom ergänztes Objekt statt das Original zu mutieren.
  function withLayoutHints(img) {
    return img.isSeries ? { ...img, extraBottom: SERIES_EXTRA_BOTTOM } : img;
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
    // Reihen-Einträge öffnen die gespeicherte Reihe (onSeriesClick), nicht
    // die normale Einzelansicht (onImageClick) -- als Bildinhalt zeigen sie
    // das erste Bild der Reihe, sonst kein visueller Unterschied im
    // Bildfeld selbst (siehe Zähler darunter).
    const handler = img.isSeries
      ? (onSeriesClick ? () => onSeriesClick(img) : null)
      : (onImageClick ? () => onImageClick(img) : null);
    if (handler) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', handler);
    }
    stageEl.appendChild(el);
    els.set(img.id, el);

    if (img.isSeries) {
      const counter = document.createElement('div');
      counter.className = 'series-counter';
      counter.textContent = String(img.count);
      counter.style.width = img.width + 'px';
      if (handler) {
        counter.style.cursor = 'pointer';
        counter.addEventListener('click', handler);
      }
      stageEl.appendChild(counter);
      counterEls.set(img.id, counter);
    }
    return el;
  }

  images.forEach(makeEl);

  function updateStageHeight() {
    const tallest = Math.max(...heightmap) + EDGE_MARGIN;
    stageEl.style.minHeight = Math.max(tallest, window.innerHeight) + 'px';
  }

  function computeLayoutFor(imgList, width) {
    const hinted = imgList.map(withLayoutHints);
    return sortMode === 'random'
      ? computeFullLayout(hinted, width, reservedArea)
      : computeChronologicalLayout(hinted, width, reservedArea);
  }

  // Fester z-index über jedem möglichen Bild-z-index (placeImage in
  // layout-engine.js würfelt dort 0-99) -- Reihen haben in diesem Sinn
  // Priorität: ihr Bild UND ihr Zähler sollen nie unter einem normalen
  // (zufällig höher liegenden) Bild versteckt sein.
  const SERIES_Z_INDEX = 100;

  // Positioniert Bild + (falls vorhanden) seinen Zähler direkt darunter,
  // rechtsbündig zur Bildbreite (siehe .series-counter in style.css).
  function applyPosition(img, pos) {
    const el = els.get(img.id);
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    el.style.zIndex = img.isSeries ? SERIES_Z_INDEX : pos.z;
    const counter = counterEls.get(img.id);
    if (counter) {
      counter.style.left = pos.left + 'px';
      counter.style.top = (pos.top + img.height + SERIES_COUNTER_GAP) + 'px';
      counter.style.zIndex = SERIES_Z_INDEX;
    }
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
   * [a]: zurück zur chronologischen Reihenfolge (Startzustand) — no-op,
   * falls bereits chronologisch (computeChronologicalLayout würfelt intern
   * ebenfalls leicht, ein erneuter Aufruf würde sonst unnötig umsortieren).
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
   * Fügt eine frisch gespeicherte Reihe hinzu (siehe "fix" in single-view.js)
   * -- analog zu addImage: schaltet auf chronologische Anzeige um und
   * scrollt dorthin, damit die Reihe wie ein gerade gepushtes Bild sichtbar
   * oben erscheint, statt in der schreibgeschützten Reihen-Ansicht zu landen.
   */
  function addSeries(entry) {
    if (!els.has(entry.id)) {
      images.unshift(entry);
      makeEl(entry);
      sortMode = 'chronological';
      layoutAll();
      notifySortMode();
    }
    els.get(entry.id).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /**
   * Ältere Bilder beim Nachladen (Scrollen) — gehören chronologisch ans
   * Ende und werden dort inkrementell platziert, ohne die bestehende
   * Anordnung anzufassen (kein Voll-Relayout nötig). Reihen-Einträge sind
   * hier nie dabei -- sie werden vollständig und ungepaginiert beim Start
   * geladen (siehe series-repo.js/main.js), nur normale Bilder wachsen
   * beim Scrollen nach.
   */
  function appendImages(newImages) {
    const width = stageEl.clientWidth || 680;
    newImages.forEach((img) => {
      if (els.has(img.id)) return; // schon vorhanden, überspringen
      images.push(img);
      makeEl(img);
      const pos = placeImage(withLayoutHints(img), heightmap, width, reservedArea);
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
    addSeries,
    appendImages,
    prependImages,
    getImages: () => images,
    elements: els,
    // Für Fenstergrößenänderungen: legt die Bilder anhand der aktuellen
    // Breite neu an (gleicher Modus wie zuvor, keine Umschaltung).
    relayout: layoutAll,
  };
}

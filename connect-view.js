// Ansicht einer einzelnen connect-Galerie (siehe [c]/main.js) -- zeigt die
// vom User zusammengestellten Bilder in derselben Anordnungslogik wie main
// (createGallery/gallery.js), aber deutlich größer (computeConnectDisplaySize)
// und bei jedem Öffnen neu zufällig gemischt: eine frische createGallery-
// Instanz pro Öffnen erledigt das automatisch (initialSortMode 'random').

import { createGallery } from './gallery.js';
import { computeConnectDisplaySize } from './image-config.js';
import { fetchConnectGalleryById, fetchRandomConnectGallery } from './connect-repo.js';
import { setClockVisible } from './clock.js';
import { randomSpot, clampToViewport } from './position-utils.js';

function toDisplayItems(members) {
  return members.map((m) => {
    const { width, height } = computeConnectDisplaySize(m.naturalWidth, m.naturalHeight);
    return { id: m.id, url: m.url, width, height };
  });
}

export function initConnectView(refs, onImageClick) {
  const { overlay, stage, escBtn, randomBtn } = refs;

  // Erhöht sich bei jeder zustandsändernden Aktion (open()/close()) --
  // analog zu single-view.js, schützt ein per [r] überholtes Nachladen.
  let openGeneration = 0;

  // Referenz auf die aktuell gerenderte Mini-Galerie -- reposition() (siehe
  // unten, Fenstergrößenänderung) braucht sie für ein relayout() (die
  // Bildbreiten hängen von der Fensterbreite ab, siehe layout-engine.js).
  let currentGallery = null;

  function repositionWords() {
    const taken = [];
    const spot1 = randomSpot(taken, { margin: 60, minDist: 140 });
    taken.push(spot1);
    escBtn.style.left = spot1.x + 'px';
    escBtn.style.top = spot1.y + 'px';
    clampToViewport(escBtn);

    const spot2 = randomSpot(taken, { margin: 60, minDist: 140 });
    randomBtn.style.left = spot2.x + 'px';
    randomBtn.style.top = spot2.y + 'px';
    clampToViewport(randomBtn);
  }

  // Jedes Öffnen bekommt eine FRISCHE createGallery-Instanz (statt einer
  // wiederverwendeten) -- einfachste Art, "immer neu zufällig gemischt"
  // (initialSortMode: 'random') zu garantieren, ohne eine eigene
  // Re-Shuffle-API nachzubauen. Die Bild-Anzahl pro Galerie ist klein genug,
  // dass das Neuerzeugen keine spürbaren Kosten hat.
  function renderGallery(members) {
    stage.innerHTML = '';
    currentGallery = createGallery(stage, toDisplayItems(members), {
      onImageClick,
      initialSortMode: 'random',
      // Bilder innerhalb einer connect-Galerie sollen sich nie überlappen,
      // anders als main/die Vorschau-Sammlung im single view (siehe
      // pickDelta in layout-engine.js).
      noOverlap: true,
    });
  }

  function showGallery(galleryData) {
    renderGallery(galleryData.images);
    overlay.style.display = 'block';
    overlay.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    setClockVisible(false);
    repositionWords();
  }

  // Liefert true/false zurück -- main.js braucht das Erfolgssignal, um beim
  // Öffnen aus der single view heraus deren Overlay erst NACH erfolgreichem
  // Laden zu schließen (siehe initSingleView-Callback in main.js). false bei
  // nicht gefundener Galerie oder wenn ein neueres open()/close() diesen
  // Aufruf zwischenzeitlich überholt hat (myGeneration-Check).
  async function open(id) {
    const myGeneration = ++openGeneration;
    const galleryData = await fetchConnectGalleryById(id);
    if (!galleryData || myGeneration !== openGeneration) return false;
    showGallery(galleryData);
    return true;
  }

  function close() {
    openGeneration += 1;
    overlay.style.display = 'none';
    stage.innerHTML = '';
    currentGallery = null;
    document.body.style.overflow = '';
  }

  // [r]: ausschließlich unter connect-Galerien browsen (nie einzelne Bilder)
  // -- eigene Tabelle, daher automatisch getrennt von single-view.js' [r].
  // Liefert true/false zurück -- main.js entscheidet [r] auf main per Zufall
  // zwischen Bildern und connect-Galerien (siehe dort) und braucht ein
  // Erfolgssignal, um bei (noch) fehlenden connect-Galerien auf ein
  // einzelnes Bild auszuweichen, statt sichtbar nichts zu tun.
  async function showRandom() {
    const myGeneration = ++openGeneration;
    const galleryData = await fetchRandomConnectGallery();
    if (!galleryData || myGeneration !== openGeneration) return false;
    showGallery(galleryData);
    return true;
  }

  escBtn.addEventListener('click', close);
  randomBtn.addEventListener('click', showRandom);

  return {
    open,
    close,
    showRandom,
    reposition: () => {
      if (overlay.style.display === 'block') {
        repositionWords();
        if (currentGallery) currentGallery.relayout();
      }
    },
  };
}

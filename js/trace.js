// "trace" — eigenständige, abgespeckte Galerie-Ansicht für eine
// Reproduktions-Familie (Original + all seine Reproduktionen, gleiche
// family_root_id). Struktur analog zu own-gallery.js/foreign-profile.js,
// aber ohne Username/Suchfeld/Collect-Drop — nur a/z/esc.

import { createGallery } from './gallery.js';
import { fetchFamilyImages } from './images-repo.js';
import { randomSpot, clampToViewport } from './position-utils.js';
import { repositionClock, setClockVisible } from './clock.js';
import { repositionShootWord, setShootWordVisible } from './shoot.js';

export function initTrace(refs, onOpenSingle) {
  const { overlay, stage, aEl, zEl, escBtn } = refs;

  let gallery = null;
  // Merkt sich, von welchem Bild aus "trace" geöffnet wurde — [b] führt
  // dorthin zurück, nicht irgendwohin (siehe escBtn-Handler unten).
  let returnImageId = null;

  function positionWords() {
    const taken = [];
    [escBtn, zEl, aEl].forEach((el) => {
      const spot = randomSpot(taken, { margin: 60 });
      taken.push(spot);
      el.style.left = spot.x + 'px';
      el.style.top = spot.y + 'px';
      clampToViewport(el);
    });
    repositionClock(taken);
    repositionShootWord(taken);
  }

  async function loadGallery(familyRootId) {
    stage.innerHTML = '';
    // Älteste zuerst (Original oben) — umgekehrt zur sonst überall
    // üblichen neueste-zuerst-Sortierung, siehe fetchFamilyImages().
    const images = await fetchFamilyImages(familyRootId);
    gallery = createGallery(stage, images, {
      // browsable: false — sonst entstünde eine Endlosschleife trace ->
      // single view -> trace -> ... (siehe single-view.js).
      onImageClick: (img) => onOpenSingle(img.id, gallery.getVisibleImages(), { silent: true, browsable: false }),
    });
  }

  async function open(familyRootId, sourceImageId) {
    returnImageId = sourceImageId;
    overlay.style.display = 'block';
    document.body.style.overflow = 'hidden';
    setClockVisible(true);
    setShootWordVisible(true);

    await loadGallery(familyRootId);
    positionWords();
  }

  function close() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    returnImageId = null;
  }

  aEl.addEventListener('click', () => {
    if (!gallery) return;
    gallery.reshuffleImages();
  });

  zEl.addEventListener('click', () => {
    if (!gallery) return;
    const images = gallery.getVisibleImages();
    if (!images.length) return;
    const pick = images[Math.floor(Math.random() * images.length)];
    // Silent: kein eigener History-Eintrag für ein innerhalb von trace
    // geöffnetes Familienmitglied — [b] von dort muss zu trace zurückführen,
    // nicht Bild für Bild durch den Browser-Verlauf (siehe single-view.js).
    // browsable: false — kein weiteres [z]-Browsen und kein "trace" von dort
    // aus (sonst Endlosschleife trace -> single view -> trace -> ...).
    onOpenSingle(pick.id, images, { silent: true, browsable: false });
  });

  escBtn.addEventListener('click', () => {
    const targetId = returnImageId;
    close();
    // Normaler (nicht stiller) Wiedereinstieg — von hier aus geht es mit
    // einem regulären [b] wieder dorthin zurück, wo man vor "reproduce"/
    // "trace" war.
    if (targetId) onOpenSingle(targetId);
  });

  return {
    open,
    close,
    repositionWords: positionWords,
    // Für Fenstergrößenänderungen.
    reflow: () => {
      if (overlay.style.display !== 'block') return;
      positionWords();
      if (gallery) gallery.relayout();
    },
  };
}

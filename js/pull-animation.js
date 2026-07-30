// Gemeinsame Flug-Animation für "pull": ein Klon des Elements (Bild oder
// Username) fliegt kurz sichtbar in die eigene Galerie hinein, verweilt
// dort kurz, und fliegt wieder zurück — während die eigene Galerie
// gleichzeitig echt geöffnet ist (mit erhöhtem z-index über allem).

const FLY_MS = 400;
const PAUSE_MS = 300;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {HTMLElement} cloneEl - unpositioniertes Klon-Element (Bild oder Text), noch nicht im DOM
 * @param {HTMLElement} sourceEl - das Original, wird während der Animation kurz unsichtbar
 * @param {DOMRect} startRect - Ausgangsposition/-größe (vom Original)
 * @param {(el: HTMLElement, rect: {left:number, top:number, width?:number, height?:number, fontSize?:string}) => void} applyRect
 * @param {string} transitionCss
 * @param {object} ownGallery - initOwnGallery()-Instanz
 * @param {() => (object|null)} getTargetRect - Zielposition, erst NACH dem Laden der Galerie aufrufbar
 */
export async function flyIntoOwnGallery({
  cloneEl, sourceEl, startRect, applyRect, transitionCss, ownGallery, getTargetRect,
}) {
  const ownOverlay = document.getElementById('own-gallery-view');
  const previousZIndex = ownOverlay.style.zIndex;

  cloneEl.style.position = 'fixed';
  cloneEl.style.zIndex = '4000';
  cloneEl.style.pointerEvents = 'none';
  cloneEl.style.transition = 'none';
  applyRect(cloneEl, startRect);
  document.body.appendChild(cloneEl);
  sourceEl.style.visibility = 'hidden';

  void cloneEl.offsetWidth; // Reflow erzwingen, damit die folgende Änderung animiert
  cloneEl.style.transition = transitionCss;

  // Eigene Galerie kurz einblenden — höherer z-index, damit sie über der
  // aktuell offenen Ansicht (Einzelansicht/fremdes Profil) sichtbar wird.
  ownOverlay.style.zIndex = '3500';
  await ownGallery.open();

  const targetRect = getTargetRect() || startRect;
  applyRect(cloneEl, targetRect);
  await wait(FLY_MS + PAUSE_MS);

  applyRect(cloneEl, startRect);
  await wait(FLY_MS);

  ownGallery.close();
  // Die darunterliegende Ansicht (Einzelansicht/fremdes Profil) bleibt
  // offen und braucht weiterhin gesperrtes Scrollen.
  document.body.style.overflow = 'hidden';
  ownOverlay.style.zIndex = previousZIndex;
  cloneEl.remove();
  sourceEl.style.visibility = 'visible';
}

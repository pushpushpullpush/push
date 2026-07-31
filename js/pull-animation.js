// Gemeinsame Flug-Animation für "pull": beim Klick erscheint unten links ein
// anklickbares "collection"-Textelement (führt zur eigenen Sammlung), und
// ein Klon des Elements (Bild oder Username) fliegt dorthin, während er
// kleiner wird. Kurz nachdem der Klon verschwunden ist, verschwindet auch
// das Label wieder. Das Original bleibt währenddessen unverändert sichtbar,
// es öffnet sich keine echte Galerie.

const FLY_MS = 400;
const PAUSE_MS = 300;
const LABEL_LINGER_MS = 500;

const CORNER_LEFT = 28;
const CORNER_BOTTOM = 28;
const LABEL_GAP = 16;
const IMAGE_THUMB_MAX = 64;
const TEXT_TARGET_FONT_SIZE = 16;
const TEXT_TARGET_HEIGHT = TEXT_TARGET_FONT_SIZE * 1.2;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "collection"-Label unten links, wie von main bekannt (.menu-word). Bleibt
 * anklickbar, solange es sichtbar ist — führt zur eigenen Sammlung.
 */
function createCollectionLabel(onOpenCollection) {
  const label = document.createElement('div');
  label.className = 'menu-word';
  label.textContent = 'collection';
  label.style.position = 'fixed';
  label.style.left = CORNER_LEFT + 'px';
  label.style.bottom = CORNER_BOTTOM + 'px';
  label.style.zIndex = '4000';
  if (onOpenCollection) label.addEventListener('click', onOpenCollection);
  document.body.appendChild(label);
  return label;
}

/**
 * Zielgröße/-position für ein Bild neben dem "collection"-Label —
 * Seitenverhältnis bleibt erhalten, die längere Seite wird auf
 * IMAGE_THUMB_MAX gestaucht.
 */
export function getImageCornerRect(startRect, labelRect) {
  const ratio = startRect.width / startRect.height;
  const width = ratio >= 1 ? IMAGE_THUMB_MAX : IMAGE_THUMB_MAX * ratio;
  const height = ratio >= 1 ? IMAGE_THUMB_MAX / ratio : IMAGE_THUMB_MAX;
  return {
    left: labelRect.right + LABEL_GAP,
    top: labelRect.top + (labelRect.height - height) / 2,
    width,
    height,
  };
}

/**
 * Zielgröße/-position für einen Username-Text neben dem "collection"-Label.
 */
export function getTextCornerRect(labelRect) {
  return {
    left: labelRect.right + LABEL_GAP,
    top: labelRect.top + (labelRect.height - TEXT_TARGET_HEIGHT) / 2,
    fontSize: TEXT_TARGET_FONT_SIZE + 'px',
  };
}

/**
 * @param {HTMLElement} cloneEl - unpositioniertes Klon-Element (Bild oder Text), noch nicht im DOM
 * @param {DOMRect} startRect - Ausgangsposition/-größe (vom Original)
 * @param {(el: HTMLElement, rect: {left:number, top:number, width?:number, height?:number, fontSize?:string}) => void} applyRect
 * @param {string} transitionCss
 * @param {(labelRect: DOMRect) => object} getTargetRect - Zielposition, abhängig von der gerenderten Größe/Position des Labels
 * @param {() => void} [onOpenCollection] - Klick auf das Label führt zur eigenen Sammlung
 */
export async function flyIntoCollection({
  cloneEl, startRect, applyRect, transitionCss, getTargetRect, onOpenCollection,
}) {
  const label = createCollectionLabel(onOpenCollection);
  const targetRect = getTargetRect(label.getBoundingClientRect());

  cloneEl.style.position = 'fixed';
  cloneEl.style.zIndex = '4000';
  cloneEl.style.pointerEvents = 'none';
  cloneEl.style.transition = 'none';
  applyRect(cloneEl, startRect);
  document.body.appendChild(cloneEl);

  void cloneEl.offsetWidth; // Reflow erzwingen, damit die folgende Änderung animiert
  cloneEl.style.transition = transitionCss;

  applyRect(cloneEl, targetRect);
  await wait(FLY_MS + PAUSE_MS);
  cloneEl.remove();

  await wait(LABEL_LINGER_MS);
  label.remove();
}

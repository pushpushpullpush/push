// Gemeinsame Positionierungs-Logik für frei platzierte Textelemente.
// Genutzt von upload.js und single-view.js.

/**
 * Schiebt ein bereits positioniertes Element zurück ins Sichtfeld,
 * falls es über einen Bildschirmrand hinausragt.
 */
export function clampToViewport(el, pad = 20) {
  const rect = el.getBoundingClientRect();
  let dx = 0;
  let dy = 0;
  if (rect.right > window.innerWidth - pad) dx = window.innerWidth - pad - rect.right;
  if (rect.left < pad) dx = pad - rect.left;
  if (rect.bottom > window.innerHeight - pad) dy = window.innerHeight - pad - rect.bottom;
  if (rect.top < pad) dy = pad - rect.top;
  if (dx || dy) {
    const currentLeft = parseFloat(el.style.left) || 0;
    const currentTop = parseFloat(el.style.top) || 0;
    el.style.left = currentLeft + dx + 'px';
    el.style.top = currentTop + dy + 'px';
  }
}

/**
 * Berechnet die Fläche, die ein Bild mit gegebenem Seitenverhältnis
 * innerhalb einer maximalen Box (object-fit: contain) einnehmen würde —
 * rechnerisch, ohne auf ein tatsächlich geladenes <img>-Element angewiesen
 * zu sein. Dadurch ist die Position sofort korrekt, unabhängig von
 * Netzwerk-/Ladezeiten.
 */
export function computeContainRect(naturalWidth, naturalHeight, { maxWidthFrac = 0.7, maxHeightFrac = 0.55, top = 100 } = {}) {
  const maxW = window.innerWidth * maxWidthFrac;
  const maxH = window.innerHeight * maxHeightFrac;
  const ratio = naturalWidth / naturalHeight;
  let width;
  let height;
  if (maxW / maxH > ratio) {
    height = maxH;
    width = maxH * ratio;
  } else {
    width = maxW;
    height = maxW / ratio;
  }
  const left = (window.innerWidth - width) / 2;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

export function pointInRect(x, y, rect, pad = 16) {
  if (!rect) return false;
  return (
    x > rect.left - pad &&
    x < rect.right + pad &&
    y > rect.top - pad &&
    y < rect.bottom + pad
  );
}

/**
 * Sucht eine zufällige Position, die genug Abstand zu bereits platzierten
 * Punkten hält UND nie im Bildbereich (avoidRect) landet. yRange schränkt
 * optional die Höhe ein, z. B. damit "push"/"comment" nie in einer
 * entlegenen Ecke landet.
 */
export function randomSpot(existing, { margin = 80, minDist = 110, yRange = null, avoidRect = null } = {}) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const x = margin + Math.random() * (window.innerWidth - margin * 2);
    let y;
    if (yRange) {
      const yMin = window.innerHeight * yRange[0];
      const yMax = window.innerHeight * yRange[1];
      y = yMin + Math.random() * (yMax - yMin);
    } else {
      y = margin + Math.random() * (window.innerHeight - margin * 2);
    }
    if (pointInRect(x, y, avoidRect)) continue;
    const farEnough = existing.every((p) => Math.hypot(p.x - x, p.y - y) > minDist);
    if (farEnough) return { x, y };
  }
  return { x: margin, y: margin };
}

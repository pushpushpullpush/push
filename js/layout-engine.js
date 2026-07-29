// Layout-Engine für push v.r.p.
// Berechnet eine dichte, unregelmäßige Anordnung von Bildern:
// keine festen Spuren, echte Lücken, Wachstum nach unten.
// Reiner Funktions-Layer — kein DOM-Zugriff, gut isoliert testbar.

const RESOLUTION = 46; // feine, unsichtbare Positionsraster-Punkte über die Breite

function pickDelta(height) {
  const r = Math.random();
  if (r < 0.55) return -height * (0.15 + Math.random() * 0.55); // deutliche Überlappung
  if (r < 0.85) return Math.random() * 10; // fast berührend
  return 8 + Math.random() * 36; // echte Lücke
}

export function createHeightmap() {
  return new Array(RESOLUTION).fill(20);
}

/**
 * Platziert genau EIN Bild gegen eine bestehende Heightmap,
 * ohne andere bereits platzierte Bilder anzufassen.
 * Wird sowohl beim vollen Neumischen als auch bei einem einzelnen Push benutzt.
 */
export function placeImage(img, heightmap, containerWidth) {
  const colWidth = containerWidth / RESOLUTION;
  const span = Math.min(RESOLUTION - 1, Math.max(1, Math.ceil(img.width / colWidth)));
  const startCol = Math.floor(Math.random() * (RESOLUTION - span));

  let base = 0;
  for (let c = startCol; c < startCol + span; c++) base = Math.max(base, heightmap[c]);

  const top = Math.max(base + pickDelta(img.height), 0);
  const left = startCol * colWidth;
  const bottom = top + img.height;

  for (let c = startCol; c < startCol + span; c++) {
    heightmap[c] = Math.max(heightmap[c], bottom);
  }

  return { left, top, z: Math.floor(Math.random() * 100) };
}

/**
 * Volles Neumischen aller Bilder — genutzt vom "r"-Befehl.
 */
export function computeFullLayout(images, containerWidth) {
  const heightmap = createHeightmap();
  const positions = new Map();

  const order = images.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  order.forEach((idx) => {
    positions.set(images[idx].id, placeImage(images[idx], heightmap, containerWidth));
  });

  const totalHeight = Math.max(...heightmap) + 40;
  return { positions, totalHeight, heightmap };
}

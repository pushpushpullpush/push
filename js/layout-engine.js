// Layout-Engine für push v.r.p.
// Berechnet eine dichte, unregelmäßige Anordnung von Bildern:
// keine festen Spuren, echte Lücken, Wachstum nach unten.
// Reiner Funktions-Layer — kein DOM-Zugriff, gut isoliert testbar.

const RESOLUTION = 46; // feine, unsichtbare Positionsraster-Punkte über die Breite

// Sicherheitsabstand zu allen vier Rändern der Galerie — Bilder sollen nie
// komplett am Rand kleben (oben, unten, links, rechts).
export const EDGE_MARGIN = 24;

// Sicherheitsabstand zur Meldungs-Konsole oben links (siehe notice-board.js)
// — deckt die längsten zu erwartenden Meldungen ab, damit nie ein Bild
// direkt darunter startet. Nur relevant, wenn containerWidth bekannt ist
// (die feste Konsole betrifft nur den sichtbaren Anfang der Galerie).
const CONSOLE_RESERVED_WIDTH = 480;
const CONSOLE_RESERVED_HEIGHT = 90;

function pickDelta(height) {
  const r = Math.random();
  if (r < 0.55) return -height * (0.05 + Math.random() * 0.15); // leichte Überlappung
  if (r < 0.85) return Math.random() * 10; // fast berührend
  return 8 + Math.random() * 36; // echte Lücke
}

// Anzahl der Spalten, die die Konsolen-Zone abdeckt — dieselbe Formel wird
// beim Vorbelegen der Heightmap UND bei jeder einzelnen Platzierung
// benutzt, damit beide exakt dieselben Spalten meinen.
function reservedColumnCount(colWidth) {
  if (!colWidth) return 0;
  return Math.min(
    Math.ceil(RESOLUTION * 0.6), // nie mehr als ~60% der Breite reservieren
    Math.ceil(CONSOLE_RESERVED_WIDTH / colWidth),
  );
}

export function createHeightmap(containerWidth) {
  const heightmap = new Array(RESOLUTION).fill(EDGE_MARGIN);
  if (containerWidth) {
    const usableWidth = Math.max(0, containerWidth - 2 * EDGE_MARGIN);
    const colWidth = usableWidth / RESOLUTION;
    const reservedCols = reservedColumnCount(colWidth);
    for (let c = 0; c < reservedCols; c++) heightmap[c] = CONSOLE_RESERVED_HEIGHT;
  }
  return heightmap;
}

/**
 * Platziert genau EIN Bild gegen eine bestehende Heightmap,
 * ohne andere bereits platzierte Bilder anzufassen.
 * Wird sowohl beim vollen Neumischen als auch bei einem einzelnen Push benutzt.
 */
export function placeImage(img, heightmap, containerWidth) {
  const usableWidth = Math.max(0, containerWidth - 2 * EDGE_MARGIN);
  const colWidth = usableWidth / RESOLUTION;
  const span = Math.min(RESOLUTION - 1, Math.max(1, Math.ceil(img.width / colWidth)));
  const startCol = Math.floor(Math.random() * (RESOLUTION - span));

  let base = 0;
  for (let c = startCol; c < startCol + span; c++) base = Math.max(base, heightmap[c]);

  // Ragt die Spanne in die reservierte Konsolen-Zone hinein, muss auch die
  // zufällige Überlappung (pickDelta, oft stark negativ) davor haltmachen —
  // sonst zieht sie das Bild trotz reservierter Fläche wieder nach oben.
  const floor = startCol < reservedColumnCount(colWidth) ? CONSOLE_RESERVED_HEIGHT : EDGE_MARGIN;
  const top = Math.max(base + pickDelta(img.height), floor);
  const left = EDGE_MARGIN + startCol * colWidth;
  const bottom = top + img.height;

  for (let c = startCol; c < startCol + span; c++) {
    heightmap[c] = Math.max(heightmap[c], bottom);
  }

  return { left, top, z: Math.floor(Math.random() * 100) };
}

/**
 * Volle chronologische Anordnung — dieselbe organische, unregelmäßige
 * Platzierung wie computeFullLayout (placeImage, mit zufälliger
 * Überlappung/Spaltenwahl), aber ohne die Reihenfolge zu mischen: images
 * wird in der übergebenen Reihenfolge (neueste zuerst) verarbeitet. Die
 * Bilder landen dadurch nicht stur exakt nacheinander, aber der höchste
 * Punkt jedes Bildes trendet mit seiner Position in der Liste — neuere
 * Bilder landen im Schnitt weiter oben, ohne dass die Anordnung starr
 * oder klar nachvollziehbar wirkt.
 */
export function computeChronologicalLayout(images, containerWidth) {
  const heightmap = createHeightmap(containerWidth);
  const positions = new Map();

  images.forEach((img) => {
    positions.set(img.id, placeImage(img, heightmap, containerWidth));
  });

  return { positions, heightmap };
}

/**
 * Volles Neumischen aller Bilder — genutzt vom "r"-Befehl.
 */
export function computeFullLayout(images, containerWidth) {
  const heightmap = createHeightmap(containerWidth);
  const positions = new Map();

  const order = images.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  order.forEach((idx) => {
    positions.set(images[idx].id, placeImage(images[idx], heightmap, containerWidth));
  });

  const totalHeight = Math.max(...heightmap) + EDGE_MARGIN;
  return { positions, totalHeight, heightmap };
}

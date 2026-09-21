// Layout-Engine für push v.r.p.
// Berechnet eine dichte, unregelmäßige Anordnung von Bildern:
// keine festen Spuren, echte Lücken, Wachstum nach unten.
// Reiner Funktions-Layer — kein DOM-Zugriff, gut isoliert testbar.

const RESOLUTION = 46; // feine, unsichtbare Positionsraster-Punkte über die Breite

// Sicherheitsabstand zu allen vier Rändern der Galerie — Bilder sollen nie
// komplett am Rand kleben (oben, unten, links, rechts).
export const EDGE_MARGIN = 24;

// Sicherheitsabstand zu einem fest positionierten Element oben links (z.B.
// die Meldungs-Konsole, siehe notice-board.js) — deckt dessen Fläche ab,
// damit nie ein Bild direkt darunter startet. Nur relevant, wenn
// containerWidth bekannt ist (ein fixes Element betrifft nur den sichtbaren
// Anfang der Galerie). Aufrufer können über den reserved-Parameter (siehe
// createHeightmap/placeImage/computeChronologicalLayout/computeFullLayout)
// eine eigene Größe übergeben.
const CONSOLE_RESERVED_WIDTH = 480;
const CONSOLE_RESERVED_HEIGHT = 90;
const DEFAULT_RESERVED = { width: CONSOLE_RESERVED_WIDTH, height: CONSOLE_RESERVED_HEIGHT };

// Mindestabstand im noOverlap-Modus (siehe unten) -- "mindestens ein
// bisschen Luft", nie 0 oder negativ.
const NO_OVERLAP_MIN_GAP = 16;

function pickDelta(height, rng, noOverlap) {
  // Erzwingt eine echte Lücke (nie Überlappung, nie Berühren) -- für die
  // Ansicht einer einzelnen connect-Galerie (connect-view.js), anders als
  // main/die Vorschau-Sammlung im single view, die bewusst überlappen dürfen
  // (siehe pickDelta-Standardverhalten unten).
  if (noOverlap) return NO_OVERLAP_MIN_GAP + rng() * 24;

  const r = rng();
  if (r < 0.55) return -height * (0.05 + rng() * 0.15); // leichte Überlappung
  if (r < 0.85) return rng() * 10; // fast berührend
  return 8 + rng() * 36; // echte Lücke
}

// FNV-1a: leichtgewichtiger String-Hash, liefert einen 32-Bit-Seed für
// mulberry32() unten. Nur zur Erzeugung eines deterministischen Seeds
// gedacht, keine kryptografischen Ansprüche.
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: kleiner, seedbarer Pseudozufallsgenerator -- liefert bei
// gleichem Seed IMMER dieselbe Zahlenfolge. Genutzt von
// computeChronologicalLayout (siehe dort), damit [a] jedes Mal exakt
// dieselbe Anordnung zeigt, statt bei jedem Klick neu zu würfeln -- sonst
// wirkt die chronologische Ordnung selbst wie ein weiterer Zufalls-Shuffle
// und ist für Betrachtende nicht als Ordnung erkennbar. computeFullLayout
// ([s], echtes Mischen) bleibt bewusst bei echtem Math.random.
function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Anzahl der Spalten, die die reservierte Zone abdeckt — dieselbe Formel
// wird beim Vorbelegen der Heightmap UND bei jeder einzelnen Platzierung
// benutzt, damit beide exakt dieselben Spalten meinen. reserved.fullWidth:
// reserviert ALLE Spalten (nicht auf ~60% gedeckelt) für reserved.height --
// für eine Konsole, die die komplette Zeilenbreite freihalten soll.
// reserved.width ist in diesem Fall bedeutungslos und wird ignoriert.
function reservedColumnCount(colWidth, reserved) {
  if (!colWidth) return 0;
  if (reserved.fullWidth) return RESOLUTION;
  return Math.min(
    Math.ceil(RESOLUTION * 0.6), // nie mehr als ~60% der Breite reservieren
    Math.ceil(reserved.width / colWidth),
  );
}

export function createHeightmap(containerWidth, reserved = DEFAULT_RESERVED) {
  const heightmap = new Array(RESOLUTION).fill(EDGE_MARGIN);
  if (containerWidth) {
    const usableWidth = Math.max(0, containerWidth - 2 * EDGE_MARGIN);
    const colWidth = usableWidth / RESOLUTION;
    const reservedCols = reservedColumnCount(colWidth, reserved);
    for (let c = 0; c < reservedCols; c++) heightmap[c] = reserved.height;
  }
  return heightmap;
}

/**
 * Platziert genau EIN Bild gegen eine bestehende Heightmap,
 * ohne andere bereits platzierte Bilder anzufassen.
 * Wird sowohl beim vollen Neumischen als auch bei einem einzelnen Push benutzt.
 * rng: Zufallsquelle, Default echtes Math.random -- computeChronologicalLayout
 * übergibt stattdessen einen pro Bild geseedeten mulberry32() (siehe dort),
 * damit dieselbe Platzierung bei jedem Aufruf reproduzierbar herauskommt.
 */
export function placeImage(img, heightmap, containerWidth, reserved = DEFAULT_RESERVED, rng = Math.random, noOverlap = false) {
  const usableWidth = Math.max(0, containerWidth - 2 * EDGE_MARGIN);
  const colWidth = usableWidth / RESOLUTION;
  const span = Math.min(RESOLUTION - 1, Math.max(1, Math.ceil(img.width / colWidth)));
  const startCol = Math.floor(rng() * (RESOLUTION - span));

  let base = 0;
  for (let c = startCol; c < startCol + span; c++) base = Math.max(base, heightmap[c]);

  // Ragt die Spanne in die reservierte Zone hinein, muss auch die zufällige
  // Überlappung (pickDelta, oft stark negativ) davor haltmachen — sonst
  // zieht sie das Bild trotz reservierter Fläche wieder nach oben.
  const floor = startCol < reservedColumnCount(colWidth, reserved) ? reserved.height : EDGE_MARGIN;
  const top = Math.max(base + pickDelta(img.height, rng, noOverlap), floor);
  const left = EDGE_MARGIN + startCol * colWidth;
  const bottom = top + img.height;

  for (let c = startCol; c < startCol + span; c++) {
    heightmap[c] = Math.max(heightmap[c], bottom);
  }

  return { left, top, z: Math.floor(rng() * 100) };
}

/**
 * Volle chronologische Anordnung — dieselbe organische, unregelmäßige
 * Platzierung wie computeFullLayout (placeImage, mit zufälliger
 * Überlappung/Spaltenwahl), aber ohne die Reihenfolge zu mischen: images
 * wird in der übergebenen Reihenfolge (neueste zuerst) verarbeitet. Die
 * Bilder landen dadurch nicht stur exakt nacheinander, aber der höchste
 * Punkt jedes Bildes trendet mit seiner Position in der Liste — neuere
 * Bilder landen im Schnitt weiter oben, ohne dass die Anordnung starr wirkt.
 *
 * Pro Bild wird ein eigener, aus seiner id geseedeter Zufallsgenerator
 * verwendet (statt eines einzigen, fortlaufenden Math.random()) -- dieselbe
 * Bild-Menge bei derselben Fensterbreite ergibt dadurch bei jedem Aufruf
 * exakt dieselbe Anordnung (siehe mulberry32/hashSeed oben). Ohne das würde
 * jeder erneute Klick auf [a] eine leicht andere, neu gewürfelte Anordnung
 * zeigen -- die chronologische Ordnung wäre dadurch von einem Shuffle nicht
 * unterscheidbar.
 */
export function computeChronologicalLayout(images, containerWidth, reserved = DEFAULT_RESERVED, { noOverlap = false } = {}) {
  const heightmap = createHeightmap(containerWidth, reserved);
  const positions = new Map();

  images.forEach((img) => {
    const rng = mulberry32(hashSeed(String(img.id)));
    positions.set(img.id, placeImage(img, heightmap, containerWidth, reserved, rng, noOverlap));
  });

  return { positions, heightmap };
}

/**
 * Volles Neumischen aller Bilder — genutzt vom "s"-Befehl (main) bzw. bei
 * jedem Öffnen einer connect-Galerie (connect-view.js, dort mit
 * noOverlap:true -- Bilder innerhalb einer connect-Galerie sollen sich nie
 * überlappen, siehe pickDelta).
 */
export function computeFullLayout(images, containerWidth, reserved = DEFAULT_RESERVED, { noOverlap = false } = {}) {
  const heightmap = createHeightmap(containerWidth, reserved);
  const positions = new Map();

  const order = images.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  order.forEach((idx) => {
    positions.set(images[idx].id, placeImage(images[idx], heightmap, containerWidth, reserved, Math.random, noOverlap));
  });

  const totalHeight = Math.max(...heightmap) + EDGE_MARGIN;
  return { positions, totalHeight, heightmap };
}


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
// eine eigene Größe übergeben, z.B. für die connect-Auswahlgalerie in
// single-view.js, die zusätzlich zum "connect"-Wort noch Vorschaubilder
// oben links zeigt und daher mehr Höhe braucht als die normale Konsole.
const CONSOLE_RESERVED_WIDTH = 480;
const CONSOLE_RESERVED_HEIGHT = 90;
const DEFAULT_RESERVED = { width: CONSOLE_RESERVED_WIDTH, height: CONSOLE_RESERVED_HEIGHT };

function pickDelta(height) {
  const r = Math.random();
  if (r < 0.55) return -height * (0.05 + Math.random() * 0.15); // leichte Überlappung
  if (r < 0.85) return Math.random() * 10; // fast berührend
  return 8 + Math.random() * 36; // echte Lücke
}

// Anzahl der Spalten, die die reservierte Zone abdeckt — dieselbe Formel
// wird beim Vorbelegen der Heightmap UND bei jeder einzelnen Platzierung
// benutzt, damit beide exakt dieselben Spalten meinen. reserved.fullWidth:
// reserviert ALLE Spalten (nicht auf ~60% gedeckelt) für reserved.height --
// für eine Konsole, die die komplette Zeilenbreite freihalten soll (siehe
// connect-Auswahlgalerie in single-view.js). reserved.width ist in diesem
// Fall bedeutungslos und wird ignoriert.
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
 */
export function placeImage(img, heightmap, containerWidth, reserved = DEFAULT_RESERVED) {
  const usableWidth = Math.max(0, containerWidth - 2 * EDGE_MARGIN);
  const colWidth = usableWidth / RESOLUTION;
  const span = Math.min(RESOLUTION - 1, Math.max(1, Math.ceil(img.width / colWidth)));
  const startCol = Math.floor(Math.random() * (RESOLUTION - span));

  let base = 0;
  for (let c = startCol; c < startCol + span; c++) base = Math.max(base, heightmap[c]);

  // Ragt die Spanne in die reservierte Zone hinein, muss auch die zufällige
  // Überlappung (pickDelta, oft stark negativ) davor haltmachen — sonst
  // zieht sie das Bild trotz reservierter Fläche wieder nach oben.
  const floor = startCol < reservedColumnCount(colWidth, reserved) ? reserved.height : EDGE_MARGIN;
  const top = Math.max(base + pickDelta(img.height), floor);
  const left = EDGE_MARGIN + startCol * colWidth;
  // extraBottom: zusätzlicher, exklusiver Platz UNTER dem Bild (z.B. für den
  // Zähler eines gespeicherten Reihen-Eintrags, siehe gallery.js) -- fließt
  // in die Heightmap ein, damit nachfolgende Bilder nicht hineinragen,
  // gehört aber NICHT zur pickDelta-Überlappungslogik des Bildes selbst
  // (der reservierte Bereich soll nie überlappt werden, anders als das Bild).
  const bottom = top + img.height + (img.extraBottom || 0);

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
export function computeChronologicalLayout(images, containerWidth, reserved = DEFAULT_RESERVED) {
  const heightmap = createHeightmap(containerWidth, reserved);
  const positions = new Map();

  images.forEach((img) => {
    positions.set(img.id, placeImage(img, heightmap, containerWidth, reserved));
  });

  return { positions, heightmap };
}

/**
 * Volles Neumischen aller Bilder — genutzt vom "s"-Befehl.
 */
export function computeFullLayout(images, containerWidth, reserved = DEFAULT_RESERVED) {
  const heightmap = createHeightmap(containerWidth, reserved);
  const positions = new Map();

  const order = images.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  order.forEach((idx) => {
    positions.set(images[idx].id, placeImage(images[idx], heightmap, containerWidth, reserved));
  });

  const totalHeight = Math.max(...heightmap) + EDGE_MARGIN;
  return { positions, totalHeight, heightmap };
}

// Statisches 2-Spalten-Layout für die Vorschau vor der allerersten
// Bestätigung einer Verbindung (pendingCandidate in single-view.js: das
// Ausgangsbild + der gewählte Kandidat, VOR dem Klick auf "connect") --
// bewusst eigenständig und unverändert seit vor Einführung der Reihen-Logik,
// nicht die organische, freie Streuung von computeSeriesLayout (die für das
// tatsächliche Diptychon/die wachsende Reihe danach gedacht ist). Der
// ruhige, feste Charakter passt besser zu diesem kurzen
// Bestätigungsmoment vor dem eigentlichen Connect. Jedes Bild füllt seine
// halbe Spalte möglichst groß aus (bis maxImageHeight), fest zentriert --
// keine Zufallskomponente.
const CONNECT_PREVIEW_ROW_GAP = 32;
const CONNECT_PREVIEW_COL_PADDING = 20;

// Unter dieser Containerbreite gilt die Smartphone-Ansicht: Bilder
// übereinander (jedes fast volle Breite) statt nebeneinander in zwei
// Spalten -- dieselbe Grenze wird in style.css für #connect-series-picker
// verwendet (dort als Media-Query, siehe Kommentar dort) und muss mit ihr
// übereinstimmen, sonst laufen Bildgrößen-Berechnung und Picker-Platzierung
// auseinander.
export const CONNECT_PREVIEW_MOBILE_BREAKPOINT = 768;

export function computeConnectPreviewLayout(images, containerWidth, maxImageHeight = 500) {
  const positions = new Map();

  // Smartphone: alle Bilder übereinander, jedes (fast) volle Breite --
  // dieselbe Anordnung gilt für die Vorschau vor der allerersten
  // Bestätigung UND für das spätere Diptychon (computeConnectPreviewLayout
  // wird für beide Zustände aufgerufen, siehe renderSeriesStage in
  // single-view.js), da hier einfach jedes Element im images-Array der
  // Reihe nach verarbeitet wird, unabhängig von dessen Länge.
  if (containerWidth < CONNECT_PREVIEW_MOBILE_BREAKPOINT) {
    const innerWidth = Math.max(0, containerWidth - CONNECT_PREVIEW_COL_PADDING * 2);
    let yMobile = EDGE_MARGIN;

    images.forEach((img) => {
      const ratio = img.width / img.height;
      let width = innerWidth;
      let height = width / ratio;
      if (height > maxImageHeight) {
        height = maxImageHeight;
        width = height * ratio;
      }
      positions.set(img.id, {
        left: (containerWidth - width) / 2,
        top: yMobile,
        width,
        height,
      });
      yMobile += height + CONNECT_PREVIEW_ROW_GAP;
    });

    const totalHeightMobile = images.length ? yMobile - CONNECT_PREVIEW_ROW_GAP + EDGE_MARGIN : EDGE_MARGIN;
    return { positions, totalHeight: totalHeightMobile };
  }

  const colWidth = containerWidth / 2;
  const colInnerWidth = Math.max(0, colWidth - CONNECT_PREVIEW_COL_PADDING * 2);
  let y = EDGE_MARGIN;

  function sizeFor(img) {
    const ratio = img.width / img.height;
    let width = colInnerWidth;
    let height = width / ratio;
    if (height > maxImageHeight) {
      height = maxImageHeight;
      width = height * ratio;
    }
    return { width, height };
  }

  for (let i = 0; i < images.length; i += 2) {
    const left = images[i];
    const right = images[i + 1] || null;
    const leftSize = sizeFor(left);
    const rightSize = right ? sizeFor(right) : null;
    const rowHeight = Math.max(leftSize.height, rightSize ? rightSize.height : 0);

    positions.set(left.id, {
      left: (colWidth - leftSize.width) / 2,
      top: y + (rowHeight - leftSize.height) / 2,
      width: leftSize.width,
      height: leftSize.height,
    });
    if (right) {
      positions.set(right.id, {
        left: colWidth + (colWidth - rightSize.width) / 2,
        top: y + (rowHeight - rightSize.height) / 2,
        width: rightSize.width,
        height: rightSize.height,
      });
    }

    y += rowHeight + CONNECT_PREVIEW_ROW_GAP;
  }

  const totalHeight = images.length ? y - CONNECT_PREVIEW_ROW_GAP + EDGE_MARGIN : EDGE_MARGIN;
  return { positions, totalHeight };
}

// Rand der Reihen-Ansicht zum Bildschirmrand -- eigene, großzügigere Werte
// als das allgemeine EDGE_MARGIN (das für das dichte Hauptgalerie-Streu-
// Muster gedacht ist und dort unangetastet bleibt): mehr sichtbare rote
// Fläche oben sowie links/rechts am Rand.
const SERIES_EDGE_MARGIN_TOP = 90;
const SERIES_EDGE_MARGIN_SIDE = 90;

// Eigenes, feineres Spalten-Raster für die Streuung der Reihen-Ansicht --
// unabhängig von RESOLUTION oben, damit beide Systeme (Hauptgalerie/Reihe)
// vollständig entkoppelt bleiben, auch wenn der Wert zufällig gleich ist.
const SERIES_RESOLUTION = 46;

// Garantierter Mindestabstand -- sowohl horizontal (in die Spalten-
// Reservierung eines Bildes eingerechnet, siehe computeSeriesLayout) als
// auch vertikal (in dessen Heightmap-Eintrag eingerechnet). SERIES_GAP_JITTER
// legt oben drauf einen zusätzlichen, rein organischen Zufalls-Anteil fest --
// nie negativ, damit sich Bilder anders als in der Hauptgalerie (deren
// pickDelta bewusst auch überlappt) nie überlappen.
const SERIES_GAP = 24;
const SERIES_GAP_JITTER = 40;

// Referenz-Seitenlänge (für ein quadratisches Bild) als Anteil der
// Fensterbreite -- bestimmt die gemeinsame Ziel-Bildfläche, siehe sizeFor.
// Nur noch der Default, falls der Aufrufer keinen eigenen targetSide-Wert
// übergibt (siehe computeSeriesLayout) -- single-view.js steuert die
// tatsächliche Größe über die "+"/"-"-Zoomstufen selbst.
const SERIES_TARGET_WIDTH_FRACTION = 0.3;

/**
 * Freie, aber garantiert überlappungsfreie Anordnung für die connect-Reihen-
 * Ansicht (single-view.js) -- dieselbe Heightmap-/Spalten-Platzierung wie
 * die Hauptgalerie (siehe createHeightmap/placeImage oben), aber mit einem
 * rein positiven Abstands-Zufall statt deren pickDelta: kein Bild überlappt
 * je ein anderes, dafür wirkt die Anordnung deutlich freier als ein starres
 * Zeilen-Raster. Eigene Heightmap/Ränder (SERIES_RESOLUTION/
 * SERIES_EDGE_MARGIN_*) statt der oben exportierten -- vollständig entkoppelt
 * von der Hauptgalerie, deren organische Streu-Ästhetik unangetastet bleibt.
 *
 * Alle Bilder bekommen dieselbe BILDFLÄCHE (unabhängig vom Seitenverhältnis)
 * -- wichtiger als eine zur normalen Einzelansicht passende Höhe (ein Bild
 * ist dadurch in Diptychon/Reihe nicht mehr zwingend gleich groß wie dort).
 * maxImageHeight (vom Aufrufer übergeben, z.B. ein Anteil von
 * window.innerHeight) bleibt als Sicherheitsnetz erhalten: ein einzelnes
 * extrem lang gezogenes Bild (image-config.js erlaubt bis zu 1:5) wird
 * notfalls unter seine Ziel-Fläche verkleinert, statt die Ansicht zu
 * sprengen -- das bleibt die Ausnahme, nicht die Regel. maxImageHeight wird
 * bewusst als Parameter erwartet statt hier window.innerHeight zu lesen --
 * dieser Layer bleibt dadurch frei von Fenster-/DOM-Zugriffen und isoliert
 * testbar (siehe Datei-Kommentar oben).
 *
 * Bilder werden der Reihe nach (Hinzufüge-Reihenfolge) gegen die Heightmap
 * platziert, bevorzugt an der Spalten-Position mit der aktuell niedrigsten
 * Heightmap (noch unbenutzter Platz) -- ein Bild landet dadurch, wenn die
 * Breite es zulässt, immer NEBEN bereits platzierten Bildern statt darunter
 * (z.B. das Diptychon aus genau zwei Bildern: nebeneinander, solange Platz
 * reicht, erst darunter, wenn nicht). Bei mehreren gleich guten Positionen
 * wird zufällig unter ihnen gewählt -- dieselbe schwache Tendenz "frühere
 * Bilder trenden weiter oben" wie bei computeChronologicalLayout, ohne die
 * Anordnung starr zu machen.
 *
 * targetSide (Referenz-Seitenlänge für ein quadratisches Bild, bestimmt die
 * gemeinsame Ziel-Bildfläche) wird vom Aufrufer übergeben -- single-view.js
 * steuert darüber die "+"/"-"-Zoomstufen der Reihen-Ansicht. Ohne Angabe
 * gilt SERIES_TARGET_WIDTH_FRACTION als Default (die bisherige, mittlere
 * Standardgröße).
 */
export function computeSeriesLayout(images, containerWidth, maxImageHeight = 500, targetSide) {
  const positions = new Map();
  const usableWidth = Math.max(0, containerWidth - 2 * SERIES_EDGE_MARGIN_SIDE);
  const colWidth = usableWidth / SERIES_RESOLUTION;

  const resolvedTargetSide = targetSide != null ? targetSide : containerWidth * SERIES_TARGET_WIDTH_FRACTION;
  const targetArea = resolvedTargetSide * resolvedTargetSide;

  function sizeFor(img) {
    const ratio = img.width / img.height;
    let width = Math.sqrt(targetArea * ratio);
    let height = Math.sqrt(targetArea / ratio);
    if (height > maxImageHeight) {
      const scale = maxImageHeight / height;
      width *= scale; height *= scale;
    }
    if (width > usableWidth) {
      const scale = usableWidth / width;
      width *= scale; height *= scale;
    }
    return { width, height };
  }

  const heightmap = new Array(SERIES_RESOLUTION).fill(SERIES_EDGE_MARGIN_TOP);

  images.forEach((img) => {
    const { width, height } = sizeFor(img);

    // Spalten-Reservierung etwas breiter als das Bild selbst -- der
    // überschüssige Teil bleibt als garantierter horizontaler Abstand zum
    // nächsten Bild frei, auch wenn dessen Spalten direkt anschließen.
    const span = Math.min(SERIES_RESOLUTION - 1, Math.max(1, Math.ceil((width + SERIES_GAP) / colWidth)));
    const maxStartCol = SERIES_RESOLUTION - span;

    // Bevorzugt die Spalten mit der aktuell niedrigsten Heightmap (noch
    // unbenutzter Platz) statt eine rein zufällige Position -- ein Bild
    // landet dadurch, wenn möglich, immer NEBEN bereits platzierten Bildern
    // statt darunter (z.B. das Diptychon aus genau zwei Bildern: das zweite
    // bekommt so lange noch komplett freie Spalten neben dem ersten, wie die
    // Breite reicht). Erst wenn kein Platz auf der aktuellen Höhe mehr frei
    // ist, rutscht ein Bild zwangsläufig darunter. Bei mehreren gleich guten
    // Positionen wird zufällig unter ihnen gewählt, damit die Anordnung
    // organisch bleibt statt immer exakt gleich (z.B. immer ganz links).
    let bestBase = Infinity;
    let candidates = [];
    for (let start = 0; start <= maxStartCol; start++) {
      let candidateBase = SERIES_EDGE_MARGIN_TOP;
      for (let c = start; c < start + span; c++) candidateBase = Math.max(candidateBase, heightmap[c]);
      if (candidateBase < bestBase - 0.01) {
        bestBase = candidateBase;
        candidates = [start];
      } else if (candidateBase <= bestBase + 0.01) {
        candidates.push(start);
      }
    }
    const startCol = candidates[Math.floor(Math.random() * candidates.length)];

    const base = bestBase;
    const top = base + Math.random() * SERIES_GAP_JITTER;
    const left = SERIES_EDGE_MARGIN_SIDE + startCol * colWidth;
    const bottom = top + height + SERIES_GAP;

    for (let c = startCol; c < startCol + span; c++) heightmap[c] = Math.max(heightmap[c], bottom);

    positions.set(img.id, { left, top, width, height });
  });

  const totalHeight = images.length ? Math.max(...heightmap) + EDGE_MARGIN : SERIES_EDGE_MARGIN_TOP;
  return { positions, totalHeight };
}

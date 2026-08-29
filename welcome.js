// Welcome-Seite — erscheint nur beim allerersten Besuch (per localStorage
// gemerkt), danach landen wiederkehrende Besucher direkt auf der Hauptseite.
// Zeigt nur "push"; nach dem Klick wird die Seite kurz ganz rot, während
// der Auftaktsatz oben links in der Konsole erscheint — verschwindet der
// Hinweis, kommt die Hauptseite zum Vorschein.

import { randomSpot, clampToViewport } from './position-utils.js';
import { setClockVisible } from './clock.js';
import { showMessage } from './notice-board.js';

const STORAGE_KEY = 'push_visited';
const TAGLINE = 'push v.r.p. – press [i] for information.';
const TAGLINE_DURATION = 3000;

function hasVisitedBefore() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false; // z.B. privater Modus ohne localStorage — zeigt die Seite eben jedes Mal
  }
}

function markVisited() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // kein Blocker, falls localStorage nicht verfügbar ist
  }
}

/**
 * @param {object} refs
 * @param {() => void} [onReady] - läuft, sobald die Hauptseite zum Vorschein
 *   kommt — sofort, falls die Welcome-Seite gar nicht gezeigt wird (bereits
 *   besucht), sonst erst nach Klick + Auftaktsatz. Genutzt vom Routing in
 *   main.js, damit eine per URL adressierte Ansicht nicht schon vor dem
 *   Auftaktsatz sichtbar wird (siehe main.js).
 */
export function initWelcome(refs, onReady) {
  const { overlay, pushEl } = refs;

  function positionPush() {
    // "push" bleibt immer im zentralen Bereich — deutlich eingerückt,
    // nicht exakt mittig, aber nie am Bildschirmrand.
    const centerMargin = window.innerWidth * 0.25;
    const pushSpot = randomSpot([], { margin: centerMargin, yRange: [0.32, 0.68] });
    pushEl.style.left = pushSpot.x + 'px';
    pushEl.style.top = pushSpot.y + 'px';
    clampToViewport(pushEl);
  }

  function enter() {
    markVisited();
    // "push" verschwindet sofort — kurz nur noch die rote Fläche, während
    // der Auftaktsatz über die Konsole läuft. Erst danach kommt die
    // Hauptseite zum Vorschein.
    pushEl.style.display = 'none';
    showMessage(TAGLINE, TAGLINE_DURATION);
    setTimeout(() => {
      overlay.style.display = 'none';
      setClockVisible(true);
      if (onReady) onReady();
    }, TAGLINE_DURATION);
  }

  pushEl.addEventListener('click', enter);

  if (hasVisitedBefore()) {
    if (onReady) onReady();
    return;
  }

  overlay.style.display = 'block';
  pushEl.style.display = 'block';
  setClockVisible(false);
  positionPush();
}

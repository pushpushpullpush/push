// Welcome-Seite — erscheint nur beim allerersten Besuch (per localStorage
// gemerkt), danach landen wiederkehrende Besucher direkt auf der Hauptseite.
// Zeigt nur "push"; nach dem Klick wird die Seite kurz ganz rot, während
// der Auftaktsatz oben links in der Konsole erscheint — verschwindet der
// Hinweis, kommt die Hauptseite zum Vorschein.

import { randomSpot, clampToViewport } from './position-utils.js';
import { setClockVisible } from './clock.js';
import { setShootWordVisible } from './shoot.js';
import { showMessage } from './notice-board.js';

const STORAGE_KEY = 'push_visited';
const TAGLINE = 'this is a collaborative project. push images to contribute';
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

export function initWelcome(refs) {
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
      setShootWordVisible(true);
    }, TAGLINE_DURATION);
  }

  pushEl.addEventListener('click', enter);

  if (hasVisitedBefore()) return;

  overlay.style.display = 'block';
  pushEl.style.display = 'block';
  setClockVisible(false);
  setShootWordVisible(false);
  positionPush();
}

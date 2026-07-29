// Datum/Uhrzeit — lokale Zeit der besuchenden Person.
// Liegt bewusst über ALLEM (auch über Overlays), damit es auf jeder
// Seite/Ansicht sichtbar bleibt. Jede Seite ruft nur mountClock() auf.

import { randomSpot, clampToViewport } from './position-utils.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

export function mountClock() {
  const el = document.createElement('div');
  el.id = 'global-clock';
  el.className = 'menu-word clock';
  el.style.position = 'fixed';
  el.style.zIndex = '9000'; // höher als jedes Overlay im Projekt
  document.body.appendChild(el);

  function update() {
    const d = new Date();
    el.textContent =
      `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  update();
  setInterval(update, 1000);
  return el;
}

/**
 * Gibt der Uhr eine neue Zufallsposition — von jeder Ansicht (Einzelansicht,
 * Upload, Auth, Hauptseite) aufrufbar, damit sie sich wie andere
 * Textelemente verhält und nichts dauerhaft verdeckt.
 */
export function repositionClock(taken = [], avoidRect = null) {
  const el = document.getElementById('global-clock');
  if (!el) return;
  const spot = randomSpot(taken, { margin: 60, avoidRect });
  el.style.left = spot.x + 'px';
  el.style.top = spot.y + 'px';
  clampToViewport(el);
  return spot;
}

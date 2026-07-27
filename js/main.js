import { getMockImages } from './mock-data.js';
import { createGallery } from './gallery.js';

const stage = document.getElementById('stage');
const menuLayer = document.getElementById('menu-layer');

const images = getMockImages(40);
const gallery = createGallery(stage, images);

// ─────────────────────────────────────────────
// Fixe Menü-Textelemente: bei jedem vollen Laden neu platziert,
// bleiben beim Scrollen an ihrer Position (position: fixed).
// ─────────────────────────────────────────────
const MENU_WORDS = ['push', 'pull', 'search', 'r', 'z', 'i'];
const placed = [];

function randomSpot() {
  const margin = 60;
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = margin + Math.random() * (window.innerWidth - margin * 2);
    const y = margin + Math.random() * (window.innerHeight - margin * 2);
    const farEnough = placed.every((p) => Math.hypot(p.x - x, p.y - y) > 140);
    if (farEnough) return { x, y };
  }
  return { x: margin, y: margin };
}

const menuEls = {};
MENU_WORDS.forEach((word) => {
  const spot = randomSpot();
  placed.push(spot);

  const el = document.createElement(word === 'search' ? 'input' : 'div');
  el.className = 'menu-word';
  el.style.left = spot.x + 'px';
  el.style.top = spot.y + 'px';

  if (word === 'search') {
    el.type = 'text';
    el.placeholder = 'search';
    el.readOnly = true;
    el.addEventListener('click', () => {
      el.readOnly = false;
      el.placeholder = '';
      el.focus();
    });
  } else {
    el.textContent = word;
  }

  menuLayer.appendChild(el);
  menuEls[word] = el;
});

// ─────────────────────────────────────────────
// Shortcuts — nur Tasten mit sichtbarem Element-Gegenstück
// ─────────────────────────────────────────────
menuEls.r.addEventListener('click', () => gallery.reshuffleImages());
menuEls.i.addEventListener('click', () => window.location.assign('info.html'));
menuEls.z.addEventListener('click', () => {
  // Platzhalter — Einzelansicht folgt als nächster Baustein
  console.log('z: zufälliges Bild in Einzelansicht (noch nicht gebaut)');
});
menuEls.push.addEventListener('click', () => {
  console.log('push: Upload-Fenster (noch nicht gebaut)');
});
menuEls.pull.addEventListener('click', () => {
  console.log('pull: eigene Galerie / log in / sign up (noch nicht gebaut)');
});

document.addEventListener('keydown', (e) => {
  const typing = document.activeElement === menuEls.search;
  if (typing) return;

  if (e.key === 'r' || e.key === 'R') gallery.reshuffleImages();
  if (e.key === 'i' || e.key === 'I') menuEls.i.click();
  if (e.key === 'z' || e.key === 'Z') menuEls.z.click();
});

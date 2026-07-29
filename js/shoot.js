import { randomSpot, clampToViewport } from './position-utils.js';

// html2canvas wird erst geladen, wenn das Tool tatsächlich zum ersten
// Mal benutzt wird — kostet also nichts, solange niemand es anfasst.
let scriptPromise = null;

function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    script.onload = () => resolve(window.html2canvas);
    script.onerror = () => reject(new Error('html2canvas konnte nicht geladen werden'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

let shootEl = null;
let armed = false;
let armTimeout = null;

function resetWord() {
  armed = false;
  if (armTimeout) clearTimeout(armTimeout);
  if (shootEl) shootEl.textContent = 's';
}

async function takeShot() {
  if (shootEl) shootEl.style.visibility = 'hidden';
  try {
    const html2canvas = await loadHtml2Canvas();
    const canvas = await html2canvas(document.documentElement, {
      useCORS: true,
      backgroundColor: '#f00000',
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const link = document.createElement('a');
    link.download = `push-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    console.error('Screenshot-Nachbau fehlgeschlagen:', err);
  } finally {
    if (shootEl) shootEl.style.visibility = 'visible';
    resetWord();
  }
}

export function trigger() {
  if (!armed) {
    armed = true;
    if (shootEl) shootEl.textContent = 'shoot';
    // Sicherheitsnetz: falls man's vergisst, springt es nach 4s zurück auf "s"
    armTimeout = setTimeout(resetWord, 4000);
  } else {
    takeShot();
  }
}

export function mountShootWord() {
  shootEl = document.createElement('div');
  shootEl.id = 'shoot-word';
  shootEl.className = 'menu-word';
  shootEl.textContent = 's';
  shootEl.style.position = 'fixed';
  shootEl.style.zIndex = '9000';
  shootEl.addEventListener('click', trigger);
  document.body.appendChild(shootEl);
  return shootEl;
}

export function repositionShootWord(taken = [], avoidRect = null) {
  if (!shootEl) return null;
  const spot = randomSpot(taken, { margin: 60, avoidRect });
  shootEl.style.left = spot.x + 'px';
  shootEl.style.top = spot.y + 'px';
  clampToViewport(shootEl);
  return spot;
}

export function setShootWordVisible(visible) {
  if (shootEl) shootEl.style.display = visible ? 'block' : 'none';
}

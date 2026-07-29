// Kurze, wechselnde Hinweise — erscheinen kurz nach erfolgreichem
// push/comment/report, damit man die Geheimnisse der Seite nach und nach
// durch Benutzung lernt, statt sie erklärt zu bekommen.

const TIPS = [
  'all pushs are anonymous',
  'click on your comment to delete',
  'use search to find tags and users',
  'press [*] or [=] to hide text',
  'press [z] for random single view',
  'press [a] to rearrange',
  'press [c] to comment image',
  'click [r] to report image',
  'press [q] to push',
  'press [p] to pull',
  "click your name to edit data",
];

let lastIndex = -1;

function getRandomTip() {
  if (TIPS.length === 1) return TIPS[0];
  let idx;
  do {
    idx = Math.floor(Math.random() * TIPS.length);
  } while (idx === lastIndex);
  lastIndex = idx;
  return TIPS[idx];
}

export function flashTip(durationMs = 2200) {
  const el = document.createElement('div');
  el.className = 'menu-word';
  el.textContent = getRandomTip();
  el.style.position = 'fixed';
  el.style.left = '24px';
  el.style.top = '24px';
  el.style.zIndex = '9600';
  el.style.fontSize = '18px';
  el.style.maxWidth = '60vw';
  el.style.cursor = 'default';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

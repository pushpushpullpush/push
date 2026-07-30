// Eine einzige Konsole oben links für alle Meldungen und Hinweise der
// Seite. Funktionale Meldungen (Fehler, Bestätigungen, Modus-Anzeige,
// Call-to-Action) haben immer Vorrang vor Hinweisen: ein Hinweis wird
// ignoriert, solange eine Meldung sichtbar ist — eine neue Meldung
// unterbricht dagegen sofort einen gerade laufenden Hinweis. Rein optisch
// ist die Konsole selbst unsichtbar, nur weiße Schrift vor rotem
// Hintergrund wie jedes andere Textelement der Seite.

const TIPS = [
  'press [z] for random single view',
  'press [c] to comment in single view',
  'click your name to edit data',
  'pulls [p] shows your collection',
  'pull an image to save it to your collection',
  'click a collection name to link it on yours',
  'pushed images cannot be deleted',
  'all images will be online forever',
  'all pushs are anonymous',
  'click your tags or comments to delete',
  'press [=] or [*] for clean mode',
  'drag&drop to push image',
  'press [q] to push',
  'tags are hidden and can be found through filter',
  'push is a visual research project',
  'press [a] to change arrangement',
];

let consoleEl = null;
let hideTimeout = null;
let messageActive = false;
let lastTipIndex = -1;

function ensureEl() {
  if (consoleEl) return consoleEl;
  consoleEl = document.createElement('div');
  consoleEl.id = 'notice-console';
  consoleEl.className = 'menu-word';
  consoleEl.style.position = 'fixed';
  consoleEl.style.left = '24px';
  consoleEl.style.top = '24px';
  consoleEl.style.zIndex = '9700';
  consoleEl.style.fontSize = '16px';
  consoleEl.style.cursor = 'default';
  consoleEl.style.maxWidth = '60vw';
  consoleEl.style.display = 'none';
  document.body.appendChild(consoleEl);
  return consoleEl;
}

function show(text, durationMs, isMessage) {
  const el = ensureEl();
  if (hideTimeout) clearTimeout(hideTimeout);
  el.textContent = text;
  el.style.display = 'block';
  messageActive = isMessage;
  hideTimeout = setTimeout(() => {
    el.style.display = 'none';
    if (isMessage) messageActive = false;
  }, durationMs);
}

// Mountet die Konsole schon beim Seitenaufbau (wie Uhr/Screenshot-Wort),
// muss aber nicht zwingend explizit aufgerufen werden — show() legt das
// Element bei Bedarf selbst an.
export function mountNoticeConsole() {
  ensureEl();
}

// Funktionale Meldungen: Fehler, Bestätigungen, Modus-Anzeige, Call-to-Action.
// Haben immer Vorrang — unterbrechen sofort einen laufenden Hinweis.
export function showMessage(text, durationMs = 2200) {
  show(text, durationMs, true);
}

function pickRandomTip() {
  if (TIPS.length === 1) return TIPS[0];
  let idx;
  do {
    idx = Math.floor(Math.random() * TIPS.length);
  } while (idx === lastTipIndex);
  lastTipIndex = idx;
  return TIPS[idx];
}

// Hinweise: niedrigere Priorität, werden ignoriert solange eine Meldung
// gerade sichtbar ist. Verschwinden immer nach einem Moment.
export function showRandomHint(durationMs = 2200) {
  if (messageActive) return;
  show(pickRandomTip(), durationMs, false);
}

// Eine einzige Konsole oben links für alle Meldungen und Hinweise der
// Seite. Funktionale Meldungen (Fehler, Bestätigungen, Modus-Anzeige,
// Call-to-Action) haben immer Vorrang vor Hinweisen: ein Hinweis wird
// ignoriert, solange eine Meldung sichtbar ist — eine neue Meldung
// unterbricht dagegen sofort einen gerade laufenden Hinweis. Rein optisch
// ist die Konsole selbst unsichtbar, nur weiße Schrift vor rotem
// Hintergrund wie jedes andere Textelement der Seite.

const TIPS = [
  'press [p] to push.',
  'press [r] to browse.',
  'click the clock to arrange.',
  'press [s] to shuffle.',
  'press [z] to go back.',
  'press [c] to connect.',
  'press [=] or [*] to enter and leave [secret mode].',
  'use your keyboard for shortcuts.',
  'drag&drop to push image.',
  'all images will be online forever.',
  'push is anonymous.',
  'push is a visual research project.',
];

let consoleEl = null;
let hideTimeout = null;
let messageActive = false;
let lastTipIndex = -1;

// Statische Meldung (z.B. "connect", solange der Auswahl-Modus aktiv ist,
// siehe main.js) -- bleibt stehen, bis clearStickyMessage() sie aufhebt.
// Eine zwischenzeitliche showMessage() (z.B. ein Fehler) überdeckt sie
// vorübergehend und render() stellt sie danach automatisch wieder her.
let stickyText = null;

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

// Zeigt die sticky-Meldung (falls aktiv) wieder an, sonst blendet aus --
// Rücksprungpunkt sowohl für den Ablauf einer show()-Meldung als auch für
// clearStickyMessage() selbst.
function render() {
  const el = ensureEl();
  if (stickyText !== null) {
    el.textContent = stickyText;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

function show(text, durationMs, isMessage) {
  const el = ensureEl();
  if (hideTimeout) clearTimeout(hideTimeout);
  el.textContent = text;
  el.style.display = 'block';
  messageActive = isMessage;
  hideTimeout = setTimeout(() => {
    hideTimeout = null;
    if (isMessage) messageActive = false;
    render();
  }, durationMs);
}

// Statische Meldung ohne automatisches Ausblenden (siehe stickyText oben).
export function showStickyMessage(text) {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  stickyText = text;
  messageActive = true;
  render();
}

export function clearStickyMessage() {
  stickyText = null;
  if (!hideTimeout) {
    messageActive = false;
    render();
  }
}

// Mountet die Konsole schon beim Seitenaufbau (wie die Uhr), muss aber
// nicht zwingend explizit aufgerufen werden — show() legt das Element bei
// Bedarf selbst an.
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
export function showRandomHint(durationMs = 4400) {
  if (messageActive) return;
  show(pickRandomTip(), durationMs, false);
}

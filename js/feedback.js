// Kurze, sichtbare Rückmeldung für fehlgeschlagene Aktionen (Netzwerk-/
// Datenbankfehler). Vorher landete das nur in der Konsole — für die
// Person vor dem Bildschirm sah es aus, als würde einfach nichts passieren.

export function flashMessage(text, durationMs = 2200) {
  const el = document.createElement('div');
  el.className = 'menu-word';
  el.textContent = text;
  el.style.position = 'fixed';
  el.style.left = '50%';
  el.style.top = '40%';
  el.style.transform = 'translate(-50%, -50%)';
  el.style.cursor = 'default';
  el.style.zIndex = '9700';
  el.style.fontSize = '16px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

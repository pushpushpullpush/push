// Kurze, sichtbare Rückmeldung für fehlgeschlagene Aktionen (Netzwerk-/
// Datenbankfehler) — läuft über die gemeinsame Meldungs-Konsole oben
// links, wie alle anderen Meldungen und Hinweise der Seite.

import { showMessage } from './notice-board.js';

export function flashMessage(text, durationMs = 2200) {
  showMessage(text, durationMs);
}

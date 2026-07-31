// Path-basiertes URL-Routing über die History API — bewusst schlank und
// unabhängig von der bestehenden Overlay-Architektur (display: block/none).
// Dieses Modul kennt keine Views, es kennt nur URLs/Titel und den
// History-Zustand; main.js verbindet es mit den einzelnen open()/close().
//
// Adressierte Ansichten: /image/:id, /u/:username, /vrp — alles andere
// (inkl. Upload/Auth) bleibt reiner Interaktionszustand ohne eigene URL.

export const HOME_PATH = '/';
export const HOME_TITLE = 'push v.r.p.';
export const VRP_PATH = '/vrp';

// true, während eine Route nur NACHVOLLZOGEN wird (popstate oder initialer
// Deep-Link-Aufruf) — die view-open()-Funktionen rufen dabei zwar weiterhin
// pushRoute() auf, das darf aber keine neue History-Eintragung erzeugen
// (sonst Endlosschleife / kaputte Vor-/Zurück-Navigation).
let silent = false;

// true, solange die aktuell offene Ansicht per direktem Linkaufruf erreicht
// wurde (kein pushState davor in dieser Session) — dann würde "zurück" die
// Seite verlassen statt zur Startseite zu führen. Siehe goBack().
let openedFromDirectLoad = false;

export async function runSilently(fn) {
  const prev = silent;
  silent = true;
  try {
    await fn();
  } finally {
    silent = prev;
  }
}

export function markOpenedFromDirectLoad() {
  openedFromDirectLoad = true;
}

export function imagePath(id) {
  return `/image/${encodeURIComponent(id)}`;
}

export function userPath(username) {
  return `/u/${encodeURIComponent(username)}`;
}

/**
 * Setzt URL + Titel für eine geöffnete Ansicht. Während runSilently() (siehe
 * oben) wird nur der Titel gesetzt, kein neuer History-Eintrag erzeugt.
 */
export function pushRoute(path, title) {
  if (title) document.title = title;
  if (silent) return;
  openedFromDirectLoad = false;
  if (location.pathname === path) return; // schon da — nichts zu tun
  history.pushState({}, '', path);
}

/**
 * Wie pushRoute(), aber ersetzt den aktuellen History-Eintrag statt einen
 * neuen zu erzeugen (history.replaceState). Für Wechsel INNERHALB einer
 * bereits offenen Ansicht — z.B. Bild-Browsen per [z] in der Einzelansicht:
 * die URL soll das gerade gezeigte Bild widerspiegeln (Reload/Teilen-Link),
 * aber jedes [z] darf keinen eigenen Schritt im Browser-Verlauf erzeugen,
 * sonst müsste man beim Zurückgehen Bild für Bild statt direkt zur
 * übergeordneten Seite zurückspringen. Rührt openedFromDirectLoad bewusst
 * nicht an — ob "zurück" zur vorherigen echten Seite führt oder (weil per
 * Direktlink geöffnet) zur Startseite, wird dadurch nicht beeinflusst.
 */
export function replaceRoute(path, title) {
  if (title) document.title = title;
  if (silent) return;
  if (location.pathname === path) return;
  history.replaceState({}, '', path);
}

/**
 * Für echte Nutzeraktionen (esc/b-Klick, nicht für interne close()-Aufrufe
 * vor einer Weiternavigation): geht zur vorherigen Ansicht zurück, wenn es
 * eine gibt — sonst (Direktaufruf eines geteilten Links) zur Startseite,
 * da "zurück" sonst die Seite verlassen würde.
 */
export function goBack() {
  if (openedFromDirectLoad) {
    openedFromDirectLoad = false;
    pushRoute(HOME_PATH, HOME_TITLE);
  } else {
    history.back();
  }
}

/**
 * Parst einen Pfad in eine Route. Unbekannte Pfade fallen auf 'home' zurück.
 */
export function parseRoute(pathname) {
  const imageMatch = pathname.match(/^\/image\/([^/]+)\/?$/);
  if (imageMatch) return { type: 'image', id: decodeURIComponent(imageMatch[1]) };

  const userMatch = pathname.match(/^\/u\/([^/]+)\/?$/);
  if (userMatch) return { type: 'user', username: decodeURIComponent(userMatch[1]) };

  if (pathname === VRP_PATH || pathname === `${VRP_PATH}/`) return { type: 'vrp' };

  return { type: 'home' };
}

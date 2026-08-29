// Path-basiertes URL-Routing über die History API — bewusst schlank und
// unabhängig von der bestehenden Overlay-Architektur (display: block/none).
// Dieses Modul kennt keine Views, es kennt nur URLs/Titel und den
// History-Zustand; main.js verbindet es mit den einzelnen open()/close().
//
// Adressierte Ansichten: /image/:id, /connect/:idA,:idB (nur die
// permanente Basis-Verbindung zwischen genau zwei Bildern), /series/:id
// (eine gespeicherte, schreibgeschützte Reihe), /vrp — alles andere (inkl.
// Upload, das freie Bauen einer noch nicht gespeicherten Reihe über die
// Basis-Verbindung hinaus) bleibt reiner Interaktionszustand ohne eigene URL.

// Manche Hosts (z.B. GitHub-Pages-Projektseiten: username.github.io/repo/)
// servieren die Seite unter einem Unterordner statt der Domain-Wurzel. Ein
// root-absoluter Pfad wie "/image/abc" würde dort an der Domain-Wurzel
// vorbeizielen. index.html setzt in diesem Fall ein <base href="/repo/">
// (siehe dort) — hier wird derselbe Unterordner ausgelesen und allen
// erzeugten/geparsten Pfaden vorangestellt, damit beide Seiten (Erzeugen via
// pushRoute/replaceRoute und Parsen via parseRoute) konsistent bleiben.
function computeBasePath() {
  const baseEl = document.querySelector('base');
  if (!baseEl) return '';
  try {
    const path = new URL(baseEl.href).pathname.replace(/\/+$/, '');
    return path;
  } catch {
    return '';
  }
}

const BASE_PATH = computeBasePath();

export const HOME_PATH = `${BASE_PATH}/`;
export const HOME_TITLE = 'push v.r.p.';
export const VRP_PATH = `${BASE_PATH}/vrp`;

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
  return `${BASE_PATH}/image/${encodeURIComponent(id)}`;
}

/**
 * Pfad für die permanente Basis-Verbindung zwischen genau zwei Bildern
 * (single-view.js) -- sortiert wie sortedPair() in connections-repo.js,
 * damit A-B und B-A dieselbe Route ergeben. Komma statt Bindestrich als
 * Trenner -- Bild-IDs sind UUIDs und enthalten selbst Bindestriche, ein
 * Split an "-" wäre nicht eindeutig umkehrbar. Das Bauen einer Reihe über
 * diese zwei Bilder hinaus (Pool, Entfernen einzelner Bilder) ist reiner
 * Client-/Sitzungszustand ohne eigene Route -- erst das Speichern einer
 * Reihe bekommt wieder eine permanente Route, siehe seriesPath() unten.
 */
export function connectPath(idA, idB) {
  const [a, b] = idA < idB ? [idA, idB] : [idB, idA];
  return `${BASE_PATH}/connect/${encodeURIComponent(a)},${encodeURIComponent(b)}`;
}

/**
 * Pfad für eine gespeicherte, schreibgeschützte Reihe (single-view.js).
 */
export function seriesPath(id) {
  return `${BASE_PATH}/series/${encodeURIComponent(id)}`;
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
 * Zieht zuerst BASE_PATH ab (siehe oben), damit main.js weiterhin einfach
 * location.pathname unverändert hereinreichen kann.
 */
export function parseRoute(pathname) {
  const relative = BASE_PATH && pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) : pathname;

  const imageMatch = relative.match(/^\/image\/([^/]+)\/?$/);
  if (imageMatch) return { type: 'image', id: decodeURIComponent(imageMatch[1]) };

  // Strikt genau zwei IDs -- die Basis-Verbindung ist ein reines
  // Zweier-Schema, es gibt keine eigene Route für eine längere, noch nicht
  // gespeicherte Reihe (siehe connectPath()).
  const connectMatch = relative.match(/^\/connect\/([^/]+)\/?$/);
  if (connectMatch) {
    const ids = connectMatch[1].split(',').map(decodeURIComponent).filter(Boolean);
    if (ids.length === 2) return { type: 'connect', ids };
  }

  const seriesMatch = relative.match(/^\/series\/([^/]+)\/?$/);
  if (seriesMatch) return { type: 'series', id: decodeURIComponent(seriesMatch[1]) };

  if (relative === '/vrp' || relative === '/vrp/') return { type: 'vrp' };

  return { type: 'home' };
}

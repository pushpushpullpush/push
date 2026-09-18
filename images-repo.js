import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

const SELECT_COLS = 'id, url, natural_width, natural_height, created_at, expires_at';

function mapRow(row) {
  const nw = row.natural_width || 1;
  const nh = row.natural_height || 1;
  const { width, height } = computeDisplaySize(nw, nh);
  return {
    id: row.id,
    url: row.url,
    width,
    height,
    // Echte Pixel-Maße (anders als width/height oben, die auf gleiche
    // Anzeigefläche normiert sind, siehe computeDisplaySize) -- für die
    // "Auflösung"-Anzeige in der Einzelansicht (single-view.js).
    naturalWidth: nw,
    naturalHeight: nh,
    createdAt: row.created_at,
    // null, falls beim Push "circulate" nicht ausgeschaltet wurde (siehe
    // upload.js) -- single-view.js zeigt den Countdown nur, wenn gesetzt.
    expiresAt: row.expires_at,
  };
}

// Bilder, deren "24h"-Widerruf beim Push aktiv war (upload.js, Consent
// "circulate" ausgeschaltet -- expires_at gesetzt), sollen nach Ablauf aus
// jeder Auswahl verschwinden: kein DB-Zugriff außer dem anon key vorhanden,
// daher kein Cron-Job, der die Zeile löscht -- stattdessen filtert jede
// Abfrage sie einfach nicht mehr mit rein. Die Zeile selbst bleibt in der
// DB bestehen, nur die Anzeige berücksichtigt sie nicht mehr.
function excludeExpired(query) {
  return query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
}

export async function fetchImages({ limit = 60, before = null } = {}) {
  let query = excludeExpired(
    supabase
      .from('images')
      .select(SELECT_COLS)
      .eq('report_hidden', false),
  )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;

  if (error) {
    console.error('Bilder laden fehlgeschlagen:', error);
    return [];
  }

  return (data || []).map(mapRow);
}

/**
 * Ein zufälliges Bild aus dem GESAMTEN Bestand -- nicht nur aus den in der
 * Hauptgalerie gerade geladenen 60(+x) (siehe fetchImages/gallery.js). [r]
 * (single-view.js) nutzt das, statt aus getImages() zu wählen: sonst hätten
 * frühe Uploads, die main nie nachlädt (kein Scrollen bis dorthin), nie eine
 * Chance, getroffen zu werden -- neuere, bereits geladene Bilder kämen
 * dagegen systematisch viel häufiger dran.
 *
 * PostgREST kennt kein "ORDER BY random()" über den Query-Builder -- daher
 * zwei Schritte: zuerst die Gesamtzahl zählen, dann eine zufällige Zeile per
 * .range() an genau dieser Position abrufen. Etwas mehr Aufwand als ein
 * einzelner Aufruf, aber ohne eigene Postgres-Funktion machbar (kein
 * DB-Admin-Zugriff vorhanden, siehe increment_image_views für den anderen
 * Fall, wo das nicht ging).
 */
export async function fetchRandomImage() {
  try {
    const { count, error: countError } = await excludeExpired(
      supabase
        .from('images')
        .select('id', { count: 'exact', head: true })
        .eq('report_hidden', false),
    );

    if (countError || !count) return null;

    const offset = Math.floor(Math.random() * count);
    const { data, error } = await excludeExpired(
      supabase
        .from('images')
        .select(SELECT_COLS)
        .eq('report_hidden', false),
    )
      .order('created_at', { ascending: false })
      .range(offset, offset);

    if (error || !data || !data.length) return null;

    return mapRow(data[0]);
  } catch (err) {
    console.error('Zufälliges Bild laden fehlgeschlagen:', err);
    return null;
  }
}

/**
 * Einzelnes Bild per ID — unabhängig davon, ob es bereits in einer geladenen
 * Galerie-Liste steckt. Für Direktaufrufe von /image/:id (geteilte Links),
 * wo das Bild z.B. älter als die zuletzt geladenen 60 sein kann.
 */
export async function fetchImageById(id) {
  const { data, error } = await supabase
    .from('images')
    .select(SELECT_COLS)
    .eq('id', id)
    .eq('report_hidden', false)
    .maybeSingle();

  if (error || !data) return null;

  return mapRow(data);
}

/**
 * Zählt einen Aufruf der Einzelansicht dieses Bildes (single-view.js, "views"
 * unter dem Bild) und liefert den neuen Gesamtstand zurück -- über die
 * Postgres-Funktion increment_image_views(p_image_id), nicht über ein
 * direktes update({view_count: ...}) hier im Client: ein Lesen-dann-Schreiben
 * wäre bei gleichzeitigen Aufrufen (zwei Betrachtende praktisch zeitgleich)
 * nicht atomar und würde Zählungen verlieren. Liefert null bei einem Fehler
 * (Netzwerk oder DB) -- single-view.js zeigt dann einfach keinen Zähler an,
 * statt eine falsche Zahl zu erfinden.
 */
export async function incrementImageViews(id) {
  try {
    const { data, error } = await supabase.rpc('increment_image_views', { p_image_id: id });
    if (error) {
      console.error('View-Zähler konnte nicht erhöht werden:', error);
      return null;
    }
    return data;
  } catch (err) {
    console.error('View-Zähler konnte nicht erhöht werden:', err);
    return null;
  }
}

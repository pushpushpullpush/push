import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

const SELECT_COLS = 'id, url, natural_width, natural_height, created_at';

function mapRow(row) {
  const nw = row.natural_width || 1;
  const nh = row.natural_height || 1;
  const { width, height } = computeDisplaySize(nw, nh);
  return {
    id: row.id,
    url: row.url,
    width,
    height,
    createdAt: row.created_at,
  };
}

export async function fetchImages({ limit = 60, before = null } = {}) {
  let query = supabase
    .from('images')
    .select(SELECT_COLS)
    .eq('report_hidden', false)
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
 * Der GESAMTE Bildbestand, ohne limit/Pagination — für die connect-Auswahl
 * (single-view.js), die unabhängig vom Ladezustand der Hauptgalerie (dort
 * lazy in 60er-Häppchen, siehe fetchImages) immer den vollständigen Bestand
 * zur Auswahl anbieten soll. Bei sehr großem Bestand später ggf. selbst
 * paginieren/virtualisieren -- für den aktuellen Umfang unproblematisch.
 */
export async function fetchAllImages() {
  try {
    const { data, error } = await supabase
      .from('images')
      .select(SELECT_COLS)
      .eq('report_hidden', false)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Bilder laden fehlgeschlagen:', error);
      return [];
    }

    return (data || []).map(mapRow);
  } catch (err) {
    // Anders als ein von Supabase selbst zurückgegebener {error} (siehe
    // oben) landen echte Netzwerkfehler (Verbindungsabbruch, Timeout) hier
    // als geworfene Exception -- ohne dieses try/catch bliebe die
    // Promise unbehandelt abgelehnt und der Aufruf in single-view.js
    // (connect-Auswahl) bricht mittendrin ab, statt geordnet mit []
    // zurückzukehren.
    console.error('Bilder laden fehlgeschlagen:', err);
    return [];
  }
}

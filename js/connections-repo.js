// "connect": dauerhafte, ungerichtete Verbindungen zwischen zwei Bildern.
// image_a_id/image_b_id werden hier immer sortiert eingefügt (kleinere id
// zuerst), damit A-B und B-A dieselbe Paarung sind -- der Unique-Constraint
// in der DB greift sonst nicht zuverlässig (siehe connections.sql).

import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

function sortedPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * Legt die Verbindung an. isDuplicate=true bei einem bereits bestehenden
 * Paar (Unique-Constraint-Verletzung) -- kein Programmfehler, kommt vor,
 * wenn dieselbe Paarung ein zweites Mal versucht wird.
 *
 * try/catch analog zu fetchAllImages() in images-repo.js: ein von Supabase
 * selbst zurückgegebenes {error} (siehe oben) ist nicht dasselbe wie ein
 * echter, geworfener Netzwerkfehler (Verbindungsabbruch, Timeout) -- ohne
 * dieses try/catch bliebe eine solche Exception hier unbehandelt und würde
 * den ganzen Connect-Vorgang in confirmSeriesConnect() (single-view.js)
 * abbrechen, OHNE dass "error: could not connect" je gezeigt wird.
 */
export async function createConnection(idA, idB) {
  const [image_a_id, image_b_id] = sortedPair(idA, idB);
  try {
    const { error } = await supabase.from('connections').insert({ image_a_id, image_b_id });
    if (error) {
      return { error, isDuplicate: error.code === '23505' };
    }
    return { error: null, isDuplicate: false };
  } catch (err) {
    console.error('Verbindung anlegen fehlgeschlagen:', err);
    return { error: err, isDuplicate: false };
  }
}

/**
 * Alle mit imageId verbundenen Bilder, älteste Verbindung zuerst/oben (siehe
 * single-view.js -- computeChronologicalLayout wird mit dieser bereits so
 * sortierten Liste aufgerufen, keine weitere Sortierung dort nötig).
 */
export async function fetchConnectedImages(imageId) {
  try {
    const { data, error } = await supabase
      .from('connections')
      .select('image_a_id, image_b_id, created_at')
      .or(`image_a_id.eq.${imageId},image_b_id.eq.${imageId}`)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Verbindungen laden fehlgeschlagen:', error);
      return [];
    }
    if (!data.length) return [];

    const otherIds = data.map((row) => (row.image_a_id === imageId ? row.image_b_id : row.image_a_id));

    const { data: imgRows, error: imgError } = await supabase
      .from('images')
      .select('id, url, natural_width, natural_height, created_at')
      .in('id', otherIds)
      .eq('report_hidden', false);

    if (imgError) {
      console.error('Verbundene Bilder laden fehlgeschlagen:', imgError);
      return [];
    }

    const byId = new Map(imgRows.map((row) => [row.id, row]));
    // otherIds ist bereits älteste-Verbindung-zuerst sortiert (siehe order()
    // oben) -- .in() garantiert selbst keine Reihenfolge, daher hier anhand
    // von otherIds neu zusammengesetzt statt imgRows direkt zu verwenden.
    return otherIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((row) => {
        const { width, height } = computeDisplaySize(row.natural_width || 1, row.natural_height || 1);
        return { id: row.id, url: row.url, width, height, createdAt: row.created_at };
      });
  } catch (err) {
    // Anders als ein von Supabase selbst zurückgegebenes {error} (siehe
    // oben) landen echte Netzwerkfehler hier als geworfene Exception --
    // ohne dieses try/catch bliebe der Pool unter dem Bild sonst einfach
    // leer stehen (unbehandelte Promise-Ablehnung), ohne jede Rückmeldung.
    console.error('Verbindungen laden fehlgeschlagen:', err);
    return [];
  }
}

/**
 * "Pool" beim Bauen einer Reihe (single-view.js): Vereinigung aller
 * Verbindungen ALLER übergebenen Bild-IDs (nicht nur eines einzelnen
 * Bildes), dedupliziert, abzüglich der bereits übergebenen IDs selbst --
 * verhindert automatisch triviale Zyklen zurück in die eigene Reihe. Eine
 * Verbindung, deren BEIDE Enden schon in imageIds enthalten sind, ist eine
 * rein interne Kante der Reihe und liefert keinen Kandidaten.
 */
export async function fetchPoolForImages(imageIds) {
  if (!imageIds.length) return [];

  try {
    const orExpr = imageIds.flatMap((id) => [`image_a_id.eq.${id}`, `image_b_id.eq.${id}`]).join(',');
    const { data, error } = await supabase
      .from('connections')
      .select('image_a_id, image_b_id, created_at')
      .or(orExpr)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Pool laden fehlgeschlagen:', error);
      return [];
    }
    if (!data.length) return [];

    const idSet = new Set(imageIds);
    const seen = new Set();
    const otherIds = [];
    data.forEach((row) => {
      const { image_a_id: a, image_b_id: b } = row;
      if (idSet.has(a) && !idSet.has(b) && !seen.has(b)) { seen.add(b); otherIds.push(b); }
      if (idSet.has(b) && !idSet.has(a) && !seen.has(a)) { seen.add(a); otherIds.push(a); }
    });
    if (!otherIds.length) return [];

    const { data: imgRows, error: imgError } = await supabase
      .from('images')
      .select('id, url, natural_width, natural_height, created_at')
      .in('id', otherIds)
      .eq('report_hidden', false);

    if (imgError) {
      console.error('Pool-Bilder laden fehlgeschlagen:', imgError);
      return [];
    }

    const byId = new Map(imgRows.map((row) => [row.id, row]));
    return otherIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((row) => {
        const { width, height } = computeDisplaySize(row.natural_width || 1, row.natural_height || 1);
        return { id: row.id, url: row.url, width, height, createdAt: row.created_at };
      });
  } catch (err) {
    // Siehe Kommentar in fetchConnectedImages oben -- echte Netzwerkfehler
    // landen hier als geworfene Exception, nicht als {error}-Rückgabewert.
    console.error('Pool laden fehlgeschlagen:', err);
    return [];
  }
}

// Zugriff auf die "connect_galleries"-Tabelle -- vom User selbst
// zusammengestellte Auswahlen bestehender Bilder (siehe [c] auf main,
// main.js). Jede Zeile trägt ihre Mitglieder-Bilder als JSON-Schnappschuss
// (id/url/natural_width/natural_height) direkt bei sich -- kein Join beim
// Anzeigen nötig, analog zu images-repo.js.

import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

const SELECT_COLS = 'id, created_at, images';

function mapMember(m) {
  return { id: m.id, url: m.url, naturalWidth: m.natural_width, naturalHeight: m.natural_height };
}

function mapRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    images: (row.images || []).map(mapMember),
  };
}

/**
 * Legt eine neue connect-Galerie an. members: [{id, url, naturalWidth,
 * naturalHeight}, ...] -- der Schnappschuss der beim Anlegen ausgewählten
 * Bilder (siehe main.js). Liefert null bei einem Fehler.
 */
export async function createConnectGallery(members) {
  const payload = members.map((m) => ({
    id: m.id,
    url: m.url,
    natural_width: m.naturalWidth,
    natural_height: m.naturalHeight,
  }));

  const { data, error } = await supabase
    .from('connect_galleries')
    .insert({ images: payload })
    .select(SELECT_COLS)
    .single();

  if (error) {
    console.error('Connect-Galerie konnte nicht erstellt werden:', error);
    return null;
  }
  return mapRow(data);
}

export async function fetchConnectGalleries({ limit = 300 } = {}) {
  const { data, error } = await supabase
    .from('connect_galleries')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Connect-Galerien laden fehlgeschlagen:', error);
    return [];
  }
  return (data || []).map(mapRow);
}

export async function fetchConnectGalleryById(id) {
  const { data, error } = await supabase
    .from('connect_galleries')
    .select(SELECT_COLS)
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return null;
  return mapRow(data);
}

/**
 * Alle connect-Galerien, die ein bestimmtes Bild enthalten -- für die
 * Vorschau-Sammlung unter dem Bild in der Einzelansicht (single-view.js).
 * "images" ist ein JSONB-Array von Schnappschüssen (siehe oben); die
 * Postgres-Containment-Prüfung (@>, hier über .contains()) findet jede Zeile,
 * deren Array irgendwo ein Element mit dieser id enthält -- unabhängig davon,
 * welche anderen Felder dieses Element sonst noch trägt.
 */
export async function fetchConnectGalleriesForImage(imageId) {
  // Bewusst .filter(...,'cs',...) statt des höherstufigen .contains(): dessen
  // Array-Zweig erzeugt eine Postgres-ARRAY-Literal-Syntax ("cs.{...}"),
  // gedacht für echte Array-Spalten (z.B. text[]) -- unsere "images"-Spalte
  // ist aber JSONB. .filter() reicht den Wert unverändert durch, ein
  // per JSON.stringify erzeugter String ergibt damit die von PostgREST für
  // jsonb erwartete "cs.<json>"-Syntax.
  const { data, error } = await supabase
    .from('connect_galleries')
    .select(SELECT_COLS)
    .filter('images', 'cs', JSON.stringify([{ id: imageId }]))
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Connect-Galerien für Bild laden fehlgeschlagen:', error);
    return [];
  }
  return (data || []).map(mapRow);
}

/**
 * Baut aus einer connect-Galerie ein main-kompatibles Vorschau-Item: EIN
 * zufällig gewähltes Mitgliedsbild, in main-Bildgröße (computeDisplaySize) --
 * geteilt zwischen main.js (Vorschau-Kachel in der Hauptgalerie) und
 * single-view.js (Vorschau-Sammlung unter dem Bild), damit beide exakt
 * dieselbe "wechselt bei jedem Neuladen zufällig"-Logik verwenden.
 *
 * excludeId: single-view.js übergibt hier die id des gerade geöffneten
 * Bildes -- die Vorschau einer Galerie, die dieses Bild enthält, soll nie
 * ausgerechnet dieses selbe Bild zeigen (sonst wirkt es, als verlinke die
 * Kachel auf "sich selbst"). Bleibt bei >=2 Mitgliedern (beim Anlegen einer
 * connect-Galerie erzwungen, siehe main.js) immer mindestens ein Kandidat übrig.
 */
export function toConnectGalleryPreviewItem(cg, { excludeId } = {}) {
  const candidates = excludeId ? cg.images.filter((m) => m.id !== excludeId) : cg.images;
  const pool = candidates.length ? candidates : cg.images;
  const preview = pool[Math.floor(Math.random() * pool.length)];
  const { width, height } = computeDisplaySize(preview.naturalWidth, preview.naturalHeight);
  return {
    id: cg.id, kind: 'connect', url: preview.url, width, height, createdAt: cg.createdAt, images: cg.images,
  };
}

/**
 * Zufällige connect-Galerie aus dem GESAMTEN Bestand -- für [r] innerhalb
 * einer geöffneten connect-Galerie (siehe connect-view.js). Gleiche
 * Zähl-plus-Zufalls-Offset-Technik wie fetchRandomImage() in
 * images-repo.js (PostgREST kennt kein ORDER BY random()).
 */
export async function fetchRandomConnectGallery() {
  try {
    const { count, error: countError } = await supabase
      .from('connect_galleries')
      .select('id', { count: 'exact', head: true });

    if (countError || !count) return null;

    const offset = Math.floor(Math.random() * count);
    const { data, error } = await supabase
      .from('connect_galleries')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .range(offset, offset);

    if (error || !data || !data.length) return null;

    return mapRow(data[0]);
  } catch (err) {
    console.error('Zufällige Connect-Galerie laden fehlgeschlagen:', err);
    return null;
  }
}

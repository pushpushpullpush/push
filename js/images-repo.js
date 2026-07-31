import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

export async function fetchImages({ limit = 60, before = null } = {}) {
  let query = supabase
    .from('images')
    .select('id, url, tags, natural_width, natural_height, created_at, family_root_id, generation')
    .eq('report_hidden', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;

  if (error) {
    console.error('Bilder laden fehlgeschlagen:', error);
    return [];
  }

  return (data || []).map((row) => {
    const nw = row.natural_width || 1;
    const nh = row.natural_height || 1;
    const { width, height } = computeDisplaySize(nw, nh);
    return {
      id: row.id,
      url: row.url,
      width,
      height,
      tags: row.tags || [],
      createdAt: row.created_at,
      familyRootId: row.family_root_id,
      generation: row.generation,
    };
  });
}

/**
 * Einzelnes Bild per ID — unabhängig davon, ob es bereits in einer geladenen
 * Galerie-Liste steckt. Für Direktaufrufe von /image/:id (geteilte Links),
 * wo das Bild z.B. älter als die zuletzt geladenen 60 sein kann.
 */
export async function fetchImageById(id) {
  const { data, error } = await supabase
    .from('images')
    .select('id, url, tags, natural_width, natural_height, created_at, family_root_id, generation')
    .eq('id', id)
    .eq('report_hidden', false)
    .maybeSingle();

  if (error || !data) return null;

  const nw = data.natural_width || 1;
  const nh = data.natural_height || 1;
  const { width, height } = computeDisplaySize(nw, nh);
  return {
    id: data.id,
    url: data.url,
    width,
    height,
    tags: data.tags || [],
    createdAt: data.created_at,
    familyRootId: data.family_root_id,
    generation: data.generation,
  };
}

/**
 * Alle Bilder derselben Reproduktions-Familie (gleiche family_root_id,
 * inklusive der Wurzel selbst — deren eigene family_root_id zeigt ja auf
 * sich selbst, siehe upload.js). Älteste zuerst (Original oben), umgekehrt
 * zur sonst überall üblichen neueste-zuerst-Sortierung — für trace.js.
 */
export async function fetchFamilyImages(familyRootId) {
  const { data, error } = await supabase
    .from('images')
    .select('id, url, tags, natural_width, natural_height, created_at, family_root_id, generation')
    .eq('family_root_id', familyRootId)
    .eq('report_hidden', false)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Familie laden fehlgeschlagen:', error);
    return [];
  }

  return (data || []).map((row) => {
    const nw = row.natural_width || 1;
    const nh = row.natural_height || 1;
    const { width, height } = computeDisplaySize(nw, nh);
    return {
      id: row.id,
      url: row.url,
      width,
      height,
      tags: row.tags || [],
      createdAt: row.created_at,
      familyRootId: row.family_root_id,
      generation: row.generation,
    };
  });
}

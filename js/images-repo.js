import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

export async function fetchImages({ limit = 60, before = null } = {}) {
  let query = supabase
    .from('images')
    .select('id, url, tags, natural_width, natural_height, created_at')
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
    };
  });
}

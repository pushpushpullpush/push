import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

export async function searchUsernames(query, limit = 20) {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('username')
    .ilike('username', `%${q}%`)
    .limit(limit);

  if (error) {
    console.error('Username-Suche fehlgeschlagen:', error);
    return [];
  }
  return (data || []).map((row) => row.username);
}

export async function fetchProfileByUsername(username) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('username', username)
    .single();

  if (error || !data) return null;
  return data;
}

function pickRandomSubset(arr, n) {
  if (arr.length <= n) return arr;
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export async function fetchUserImages(userId, limit = 300) {
  // 1. Alle Bild-IDs holen, die die Person je gepullt hat (leichtgewichtig)
  const { data: allPulls, error: pullsError } = await supabase
    .from('pulls')
    .select('image_id')
    .eq('user_id', userId);

  if (pullsError) {
    console.error('Pulls laden fehlgeschlagen:', pullsError);
    return [];
  }
  if (!allPulls || !allPulls.length) return [];

  // 2. Zufällige Auswahl aus dem gesamten Pool — so tauchen alte Pulls über
  // die Zeit hinweg immer wieder auf, statt dauerhaft hinter den neuesten
  // zu verschwinden.
  const chosenIds = pickRandomSubset(allPulls.map((p) => p.image_id), limit);

  // 3. Volle Bilddaten nur für die ausgewählten IDs abrufen
  const { data, error } = await supabase
    .from('images')
    .select('id, url, tags, natural_width, natural_height')
    .in('id', chosenIds);

  if (error) {
    console.error('Bilder laden fehlgeschlagen:', error);
    return [];
  }

  return (data || []).map((img) => {
    const nw = img.natural_width || 1;
    const nh = img.natural_height || 1;
    const { width, height } = computeDisplaySize(nw, nh);
    return { id: img.id, url: img.url, width, height, tags: img.tags || [] };
  });
}

// Wer hat dieses Bild gepullt — für die Puller-Liste in der Einzelansicht.
export async function fetchPullersForImage(imageId) {
  const { data, error } = await supabase
    .from('pulls')
    .select('profiles ( username )')
    .eq('image_id', imageId);

  if (error) {
    console.error('Puller laden fehlgeschlagen:', error);
    return [];
  }
  return (data || [])
    .filter((row) => row.profiles)
    .map((row) => row.profiles.username);
}

// Wem folgt diese Person — Einbahnstraße, keine Follower-Liste.
export async function fetchFollowing(userId) {
  const { data, error } = await supabase
    .from('follows')
    .select('followed_user_id, profiles!follows_followed_user_id_fkey ( username )')
    .eq('follower_user_id', userId);

  if (error) {
    console.error('Follows laden fehlgeschlagen:', error);
    return [];
  }
  return (data || [])
    .filter((row) => row.profiles)
    .map((row) => row.profiles.username);
}

export async function isFollowing(followerId, followedId) {
  const { data } = await supabase
    .from('follows')
    .select('id')
    .eq('follower_user_id', followerId)
    .eq('followed_user_id', followedId)
    .maybeSingle();
  return !!data;
}

export async function follow(followerId, followedId) {
  const { error } = await supabase
    .from('follows')
    .insert({ follower_user_id: followerId, followed_user_id: followedId });
  return !error;
}

export async function unfollow(followerId, followedId) {
  const { error } = await supabase
    .from('follows')
    .delete()
    .eq('follower_user_id', followerId)
    .eq('followed_user_id', followedId);
  return !error;
}

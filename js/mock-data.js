// Platzhalter-Datenquelle.
// Sobald Supabase angebunden ist, wird nur diese Datei durch echte
// Abfragen ersetzt — der Rest des Codes kennt nur die Form
// { id, url, color, width, height, tags }.

import { MAX_ASPECT_RATIO, computeDisplaySize } from './image-config.js';

const COLORS = ['#00eaff', '#1a1aff', '#ff00ff', '#ffee00', '#00cc44', '#111111'];
const SAMPLE_TAGS = ['madrid', 'sunny', 'friends', 'vacation', 'blue', 'night', 'city', 'analog'];

export function getMockImages(count = 40) {
  const images = [];
  for (let i = 0; i < count; i++) {
    // Zufälliges Seitenverhältnis innerhalb des erlaubten Rahmens (max 1:5),
    // zufällig quer oder hoch — Fläche bleibt für alle ungefähr gleich groß.
    const ratio = 1 + Math.random() * (MAX_ASPECT_RATIO - 1);
    const landscape = Math.random() < 0.5;
    const naturalWidth = landscape ? ratio : 1;
    const naturalHeight = landscape ? 1 : ratio;
    const { width, height } = computeDisplaySize(naturalWidth, naturalHeight);

    const tagCount = Math.floor(Math.random() * 3);
    const tags = [];
    for (let t = 0; t < tagCount; t++) {
      const tag = SAMPLE_TAGS[Math.floor(Math.random() * SAMPLE_TAGS.length)];
      if (!tags.includes(tag)) tags.push(tag);
    }

    images.push({
      id: `mock-${i}`,
      url: null, // später: echte Bild-URL aus Supabase Storage
      color: COLORS[i % COLORS.length], // Platzhalter, solange url null ist
      width,
      height,
      tags,
    });
  }
  return images;
}

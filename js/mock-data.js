// Platzhalter-Datenquelle.
// Sobald Supabase angebunden ist, wird nur diese Datei durch echte
// Abfragen ersetzt — der Rest des Codes kennt nur die Form
// { id, url, color, width, height, tags }.

const COLORS = ['#00eaff', '#1a1aff', '#ff00ff', '#ffee00', '#00cc44', '#111111'];
const IMG_WIDTH = 150;

export function getMockImages(count = 40) {
  const images = [];
  for (let i = 0; i < count; i++) {
    images.push({
      id: `mock-${i}`,
      url: null, // später: echte Bild-URL aus Supabase Storage
      color: COLORS[i % COLORS.length], // Platzhalter, solange url null ist
      width: IMG_WIDTH,
      height: 80 + Math.floor(Math.random() * 200),
      tags: [],
    });
  }
  return images;
}

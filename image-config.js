// Zentrale Werte für Bildgröße und Seitenverhältnis-Limit.

export const BASE_SIDE = 170; // Referenzgröße: Seitenlänge eines quadratischen Bildes
export const TARGET_AREA = BASE_SIDE * BASE_SIDE;
export const MAX_ASPECT_RATIO = 5; // maximales Verhältnis lang:kurz (1:5)

/**
 * Berechnet Anzeige-Breite/Höhe so, dass die BILDFLÄCHE für alle Bilder
 * ungefähr gleich bleibt, unabhängig vom Seitenverhältnis. Ein normales
 * Foto (z.B. 4:3) wirkt dadurch angenehm groß; ein extrem lang gezogenes
 * Format wird von selbst schmal und unauffällig, statt den Bildschirm
 * zu dominieren — ganz ohne festen Maximalwert.
 */
export function computeDisplaySize(naturalWidth, naturalHeight) {
  const ratio = naturalWidth / naturalHeight;
  return {
    width: Math.sqrt(TARGET_AREA * ratio),
    height: Math.sqrt(TARGET_AREA / ratio),
  };
}

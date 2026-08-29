// "Reihe speichern": eigenes, persistiertes Objekt zusätzlich zum reinen
// connections-Graphen (siehe connections-repo.js) -- eine gespeicherte
// Reihe ist ein Kurations-/Auswahlakt (welche Bilder, in welcher
// Reihenfolge), der über die einzelnen dauerhaften Zweier-Verbindungen
// hinausgeht und unabhängig von ihnen festgehalten wird. Anonym wie der
// Rest der Seite: keine Autorschaft, keine Sitzungsbindung. Einmal
// gespeichert unveränderlich (siehe series.sql -- keine update/delete-
// Policy), daher auch hier keine entsprechenden Funktionen.

import { supabase } from './supabase-client.js';
import { computeDisplaySize } from './image-config.js';

/**
 * layout: das eingefrorene Arrangement zum Zeitpunkt des Fixierens (siehe
 * handleFixClick in single-view.js) -- Position/Größe jedes Bildes bei einer
 * bestimmten Referenz-Fensterbreite, wie bei einem Screenshot. Wird beim
 * Anzeigen 1:1 (nur proportional auf die jeweils aktuelle Fensterbreite
 * skaliert) wiederverwendet, statt bei jedem Aufruf neu zu berechnen --
 * alle Betrachter sehen dadurch dieselbe Anordnung, nicht nur dieselben
 * Bilder in derselben Reihenfolge.
 */
export async function createSeries(imageIds, layout) {
  const { data, error } = await supabase
    .from('series')
    .insert({ image_ids: imageIds, layout })
    .select('id')
    .single();

  if (error) {
    console.error('Reihe speichern fehlgeschlagen:', error);
    return { error };
  }
  return { error: null, id: data.id };
}

/**
 * Liest eine gespeicherte Reihe inkl. aller Bilddaten, in der gespeicherten
 * Reihenfolge -- image_ids selbst trägt bereits die Reihenfolge, .in()
 * garantiert aber keine, daher hier anhand von image_ids neu zusammengesetzt.
 * null, falls die Reihe nicht existiert oder eines ihrer Bilder inzwischen
 * nicht mehr auflösbar ist (report_hidden) -- eine Reihe mit Lücke wäre kein
 * sinnvoller Anzeigezustand für einen fixierten Schnappschuss.
 *
 * layout kann null sein -- entweder eine vor Einführung dieses Felds
 * gespeicherte Reihe, oder (theoretisch) ein Fehlschlag beim Erfassen zum
 * Fixier-Zeitpunkt. single-view.js fällt in diesem Fall auf die normale,
 * live berechnete Anordnung zurück (siehe renderSeriesStage dort).
 */
export async function fetchSeriesById(id) {
  const { data, error } = await supabase
    .from('series')
    .select('id, image_ids, layout')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) return null;

  const { data: imgRows, error: imgError } = await supabase
    .from('images')
    .select('id, url, natural_width, natural_height, created_at')
    .in('id', data.image_ids)
    .eq('report_hidden', false);

  if (imgError) {
    console.error('Reihen-Bilder laden fehlgeschlagen:', imgError);
    return null;
  }

  const byId = new Map(imgRows.map((row) => [row.id, row]));
  const images = data.image_ids.map((imgId) => {
    const row = byId.get(imgId);
    if (!row) return null;
    const { width, height } = computeDisplaySize(row.natural_width || 1, row.natural_height || 1);
    return { id: row.id, url: row.url, width, height, createdAt: row.created_at };
  });

  if (images.some((img) => !img)) return null;
  return { id: data.id, images, layout: data.layout || null };
}

/**
 * Alle gespeicherten Reihen für die Hauptgalerie (main.js) -- jeweils ein
 * zufällig gewähltes Bild der Reihe (als Anzeige-Bild) plus Anzahl (für den
 * Zähler darunter, siehe layout-engine.js/gallery.js). Ungepaginiert wie
 * fetchAllImages() in images-repo.js -- die Anzahl gespeicherter Reihen
 * dürfte auf absehbare Zeit deutlich kleiner bleiben als die Anzahl
 * gepushter Bilder; bei starkem Wachstum später ggf. selbst paginieren.
 *
 * Das Anzeige-Bild wird HIER, bei jedem Aufruf, neu zufällig gewählt --
 * main.js ruft diese Funktion nur EINMAL pro Seitenaufbau auf (siehe dort),
 * das Anzeige-Bild wechselt dadurch bei jedem neuen Laden von main, bleibt
 * aber innerhalb einer Sitzung stabil: [s]/[a] sortieren nur die bereits
 * geladenen Objekte um (siehe gallery.js), ohne diese Funktion erneut
 * aufzurufen.
 */
export async function fetchAllSeriesSummaries() {
  const { data, error } = await supabase
    .from('series')
    .select('id, image_ids, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Reihen laden fehlgeschlagen:', error);
    return [];
  }
  if (!data.length) return [];

  const coverIds = data.map((row) => row.image_ids[Math.floor(Math.random() * row.image_ids.length)]);
  const { data: imgRows, error: imgError } = await supabase
    .from('images')
    .select('id, url, natural_width, natural_height')
    .in('id', coverIds);

  if (imgError) {
    console.error('Reihen-Vorschaubilder laden fehlgeschlagen:', imgError);
    return [];
  }
  const byId = new Map(imgRows.map((row) => [row.id, row]));

  return data
    .map((row, i) => {
      const coverImg = byId.get(coverIds[i]);
      if (!coverImg) return null; // gewähltes Bild inzwischen nicht mehr auflösbar
      const { width, height } = computeDisplaySize(coverImg.natural_width || 1, coverImg.natural_height || 1);
      return {
        id: row.id,
        url: coverImg.url,
        width,
        height,
        count: row.image_ids.length,
        createdAt: row.created_at,
        isSeries: true,
      };
    })
    .filter(Boolean);
}

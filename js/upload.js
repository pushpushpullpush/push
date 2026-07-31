import { supabase } from './supabase-client.js';
import { MAX_ASPECT_RATIO, computeDisplaySize } from './image-config.js';
import { randomSpot, clampToViewport, computeContainRect } from './position-utils.js';
import { repositionClock } from './clock.js';
import { repositionShootWord } from './shoot.js';
import { flashMessage } from './feedback.js';
import { showRandomHint } from './notice-board.js';
import { setShootWordVisible } from './shoot.js';

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 21;

// heic2any wird nur bei Bedarf geladen (HEIC-Dateien vom Handy),
// genau wie html2canvas beim Screenshot-Tool.
let heic2anyPromise = null;
function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (heic2anyPromise) return heic2anyPromise;
  heic2anyPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/heic2any/dist/heic2any.min.js';
    script.onload = () => resolve(window.heic2any);
    script.onerror = () => reject(new Error('heic2any konnte nicht geladen werden'));
    document.head.appendChild(script);
  });
  return heic2anyPromise;
}

function isHeicFile(file) {
  const name = (file.name || '').toLowerCase();
  return file.type === 'image/heic' || file.type === 'image/heif'
    || name.endsWith('.heic') || name.endsWith('.heif');
}

async function normalizeImageFile(file) {
  if (!isHeicFile(file)) return file;
  const heic2any = await loadHeic2Any();
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], (file.name || 'image').replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' });
}

function getClockPoint() {
  const el = document.getElementById('global-clock');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

export function initUpload(refs, onUploaded) {
  const { fileInput, overlay, preview, tagInput, tagChips, escBtn, submitBtn } = refs;

  tagInput.maxLength = MAX_TAG_LENGTH; // echtes Zeichenlimit, kein Fehlerhinweis nötig

  let pendingBlob = null;
  let pendingTags = [];
  let pendingTagSpots = [];
  let pendingDisplaySize = null;
  let pendingNaturalSize = null;
  let pendingReproducedFromId = null; // gesetzt nur bei reproduce (siehe openWithBlob)
  let previewObjectUrl = null; // nur bei openWithBlob gesetzt, muss revoked werden
  let currentImageRect = null;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) startUpload(file);
    fileInput.value = '';
  });

  function repositionWords() {
    // esc, tags und push bekommen bei jedem neuen Push neue, einander nicht
    // überlappende Positionen — meiden dabei die Bildfläche.
    const taken = [];

    const escSpot = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
    taken.push(escSpot);
    escBtn.style.left = escSpot.x + 'px';
    escBtn.style.top = escSpot.y + 'px';
    escBtn.style.right = 'auto';
    clampToViewport(escBtn);

    const tagSpot = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
    taken.push(tagSpot);
    tagInput.style.left = tagSpot.x + 'px';
    tagInput.style.top = tagSpot.y + 'px';
    tagInput.style.bottom = 'auto';
    clampToViewport(tagInput);

    const pushSpot = randomSpot(taken, {
      margin: 80,
      minDist: 120,
      yRange: [0.6, 0.85],
      avoidRect: currentImageRect,
    });
    taken.push(pushSpot);
    submitBtn.style.left = pushSpot.x + 'px';
    submitBtn.style.top = pushSpot.y + 'px';
    submitBtn.style.bottom = 'auto';
    clampToViewport(submitBtn);

    repositionClock(taken, currentImageRect);
    repositionShootWord(taken, currentImageRect);

    return taken;
  }

  async function startUpload(file) {
    try {
      file = await normalizeImageFile(file);
    } catch (err) {
      console.error('HEIC-Konvertierung fehlgeschlagen:', err);
      flashMessage('error: could not read this image');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => {
        flashMessage('error: unsupported image format');
      };
      img.onload = () => {
        const ratio = Math.max(img.width, img.height) / Math.min(img.width, img.height);
        if (ratio > MAX_ASPECT_RATIO) {
          flashMessage(`error: aspect ratio too extreme (max 1:${MAX_ASPECT_RATIO})`);
          return;
        }

        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
          width *= scale;
          height *= scale;
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        preview.src = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        canvas.toBlob((blob) => {
          pendingBlob = blob;
        }, 'image/jpeg', JPEG_QUALITY);

        pendingNaturalSize = { width: Math.round(width), height: Math.round(height) };

        // Flächen-basierte Anzeigegröße — normale Proportionen wirken groß,
        // extreme Formate werden von selbst schmal statt dominant.
        pendingDisplaySize = computeDisplaySize(width, height);

        pendingReproducedFromId = null; // normaler Push, keine Reproduktions-Genealogie
        if (previewObjectUrl) {
          URL.revokeObjectURL(previewObjectUrl);
          previewObjectUrl = null;
        }
        pendingTags = [];
        pendingTagSpots = [];
        renderTags();

        // Bildfläche berechnet statt gemessen — sofort korrekt, unabhängig
        // vom Ladezustand des Vorschaubilds.
        currentImageRect = computeContainRect(width, height);
        preview.style.width = currentImageRect.width + 'px';
        preview.style.height = currentImageRect.height + 'px';
        preview.style.left = currentImageRect.left + 'px';
        preview.style.top = currentImageRect.top + 'px';
        preview.style.transform = 'none';

        overlay.style.display = 'block';
        setShootWordVisible(false);
        repositionWords();
        // Cursor steht direkt im Tag-Feld, damit man ohne extra Klick tippen kann.
        requestAnimationFrame(() => tagInput.focus());
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  /**
   * Wie startUpload(), aber für einen bereits fertig prozessierten Blob
   * (reproduce in single-view.js) — durchläuft NICHT noch einmal das
   * Redraw/Re-Encode von startUpload() (das würde die dort absichtlich
   * gewählte Degradation/den Ausschnitt wieder überschreiben bzw. verwässern),
   * übernimmt den Blob unverändert. Startet wie ein regulärer Push komplett
   * ohne Tags — keine Übernahme vom Originalbild. reproducedFromId löst beim
   * Push die Familien-Wurzel/Generation auf.
   */
  function openWithBlob(blob, { width, height, reproducedFromId = null } = {}) {
    pendingBlob = blob;
    pendingNaturalSize = { width: Math.round(width), height: Math.round(height) };
    pendingDisplaySize = computeDisplaySize(width, height);
    pendingReproducedFromId = reproducedFromId;

    currentImageRect = computeContainRect(width, height);
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(blob);
    preview.src = previewObjectUrl;
    preview.style.width = currentImageRect.width + 'px';
    preview.style.height = currentImageRect.height + 'px';
    preview.style.left = currentImageRect.left + 'px';
    preview.style.top = currentImageRect.top + 'px';
    preview.style.transform = 'none';

    pendingTags = [];
    pendingTagSpots = [];
    renderTags();

    overlay.style.display = 'block';
    setShootWordVisible(false);
    repositionWords();
    requestAnimationFrame(() => tagInput.focus());
  }

  function closeOverlay() {
    overlay.style.display = 'none';
    setShootWordVisible(true);
    pendingBlob = null;
    pendingTags = [];
    pendingTagSpots = [];
    pendingDisplaySize = null;
    pendingNaturalSize = null;
    pendingReproducedFromId = null;
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }
    currentImageRect = null;
    tagInput.value = '';
  }

  function showTagDeleteConfirm(chip, index) {
    chip.innerHTML = '';

    const deleteWord = document.createElement('span');
    deleteWord.textContent = 'delete';
    deleteWord.style.cursor = 'pointer';
    deleteWord.style.marginRight = '10px';

    const escWord = document.createElement('span');
    escWord.textContent = 'b';
    escWord.style.cursor = 'pointer';

    chip.appendChild(deleteWord);
    chip.appendChild(escWord);

    escWord.addEventListener('click', (e) => {
      e.stopPropagation();
      renderTags();
    });

    deleteWord.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingTags.splice(index, 1);
      pendingTagSpots.splice(index, 1);
      renderTags();
    });
  }

  function renderTags() {
    tagChips.innerHTML = '';
    pendingTags.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = t;
      chip.style.left = pendingTagSpots[i].x + 'px';
      chip.style.top = pendingTagSpots[i].y + 'px';
      chip.style.cursor = 'pointer';
      chip.style.pointerEvents = 'auto'; // Container hat pointer-events:none
      chip.addEventListener('click', () => showTagDeleteConfirm(chip, i));
      tagChips.appendChild(chip);
      clampToViewport(chip);
    });
  }

  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const val = tagInput.value.trim().toLowerCase();
      if (val && pendingTags.length < MAX_TAGS && !pendingTags.includes(val)) {
        pendingTags.push(val);
        pendingTagSpots.push(randomSpot([], { margin: 40, avoidRect: currentImageRect }));
        renderTags();
      }
      tagInput.value = '';
    }
  });

  escBtn.addEventListener('click', closeOverlay);

  let isUploading = false;

  submitBtn.addEventListener('click', async () => {
    if (!pendingBlob || isUploading) return;

    if (pendingTags.length === 0) {
      flashMessage('error: insert at least one tag');
      return;
    }

    isUploading = true;
    submitBtn.style.pointerEvents = 'none';
    submitBtn.style.opacity = '0.3';

    try {
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
      const path = `uploads/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('images')
        .upload(path, pendingBlob, { contentType: 'image/jpeg' });

      if (uploadError) {
        console.error('Upload fehlgeschlagen:', uploadError);
        flashMessage('error: upload failed');
        return;
      }

      const { data: publicData } = supabase.storage.from('images').getPublicUrl(path);

      // Reproduktions-Genealogie: gemeinsame Familien-Wurzel + Generation
      // auflösen, BEVOR das neue Bild eingefügt wird — nur relevant, wenn
      // dieser Push aus "reproduce" in single-view.js kommt (siehe
      // openWithBlob oben). newGeneration bleibt null (= DB-Default 0), falls
      // die Wurzel nicht sicher aufgelöst werden konnte — ein Bild ohne
      // family_root_id soll auch keine Generation > 0 tragen.
      let familyRootId = null;
      let newGeneration = null;
      if (pendingReproducedFromId) {
        const { data: sourceRow, error: sourceError } = await supabase
          .from('images')
          .select('family_root_id, generation')
          .eq('id', pendingReproducedFromId)
          .maybeSingle();

        if (sourceError) {
          console.error('Familien-Wurzel lesen fehlgeschlagen:', sourceError);
        } else if (sourceRow) {
          if (sourceRow.family_root_id) {
            // Ausgangsbild ist bereits Teil einer Familie — dieselbe Wurzel übernehmen.
            familyRootId = sourceRow.family_root_id;
          } else {
            // Ausgangsbild tritt hiermit selbst in eine Familie ein: eigene id als Wurzel.
            // .select() danach ist Pflicht: eine per RLS blockierte Zeile liefert
            // sonst error:null UND ein leeres data-Array — ohne diese Prüfung sieht
            // das wie Erfolg aus, obwohl nichts geschrieben wurde.
            const { data: rootUpdateData, error: rootUpdateError } = await supabase
              .from('images')
              .update({ family_root_id: pendingReproducedFromId })
              .eq('id', pendingReproducedFromId)
              .select('id');
            if (rootUpdateError || !rootUpdateData || rootUpdateData.length === 0) {
              console.error('Familien-Wurzel setzen fehlgeschlagen:', rootUpdateError || 'keine Zeile betroffen (RLS?)');
            } else {
              familyRootId = pendingReproducedFromId;
            }
          }
          if (familyRootId) {
            newGeneration = (sourceRow.generation || 0) + 1;
          }
        }
      }

      const { data: inserted, error: insertError } = await supabase
        .from('images')
        .insert({
          url: publicData.publicUrl,
          tags: pendingTags,
          natural_width: pendingNaturalSize.width,
          natural_height: pendingNaturalSize.height,
          family_root_id: familyRootId,
          // undefined statt null, damit ohne reproduce-Kontext einfach der
          // DB-Default (0) greift, statt ihn mit einem expliziten null zu überschreiben.
          generation: newGeneration === null ? undefined : newGeneration,
        })
        .select()
        .single();

      if (insertError) {
        console.error('Datenbankeintrag fehlgeschlagen:', insertError);
        flashMessage('error: could not save image');
        return;
      }

      const displaySize = pendingDisplaySize;
      closeOverlay();
      showRandomHint();

      onUploaded({
        id: inserted.id,
        url: inserted.url,
        width: displaySize.width,
        height: displaySize.height,
        tags: inserted.tags,
        familyRootId: inserted.family_root_id,
        generation: inserted.generation,
      });
    } finally {
      isUploading = false;
      submitBtn.style.pointerEvents = 'auto';
      submitBtn.style.opacity = '1';
    }
  });

  return {
    handleFile: startUpload,
    // Für reproduce in single-view.js: bereits fertig prozessierter Blob
    // (Fragment/Auflösungsreduktion), keine erneute Größen-/Qualitäts-
    // Bearbeitung mehr.
    openWithBlob,
    // Für Fenstergrößenänderungen: nur die frei positionierten Textelemente
    // zurück in den sichtbaren Bereich holen — das Vorschaubild behält
    // seine ursprüngliche Größe.
    reposition: () => {
      if (overlay.style.display === 'block') repositionWords();
    },
  };
}

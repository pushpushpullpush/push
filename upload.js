import { supabase } from './supabase-client.js';
import { MAX_ASPECT_RATIO, computeDisplaySize } from './image-config.js';
import { randomSpot, clampToViewport, computeContainRect } from './position-utils.js';
import { repositionClock } from './clock.js';
import { flashMessage } from './feedback.js';
import { showRandomHint } from './notice-board.js';

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

// heic2any wird nur bei Bedarf geladen (HEIC-Dateien vom Handy).
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

export function initUpload(refs, onUploaded) {
  const { fileInput, overlay, preview, escBtn, submitBtn } = refs;

  let pendingBlob = null;
  let pendingDisplaySize = null;
  let pendingNaturalSize = null;
  let currentImageRect = null;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) startUpload(file);
    fileInput.value = '';
  });

  function repositionWords() {
    // esc und push bekommen bei jedem neuen Push neue, einander nicht
    // überlappende Positionen — meiden dabei die Bildfläche.
    const taken = [];

    const escSpot = randomSpot(taken, { margin: 60, avoidRect: currentImageRect });
    taken.push(escSpot);
    escBtn.style.left = escSpot.x + 'px';
    escBtn.style.top = escSpot.y + 'px';
    escBtn.style.right = 'auto';
    clampToViewport(escBtn);

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

        // Bildfläche berechnet statt gemessen — sofort korrekt, unabhängig
        // vom Ladezustand des Vorschaubilds.
        currentImageRect = computeContainRect(width, height);
        preview.style.width = currentImageRect.width + 'px';
        preview.style.height = currentImageRect.height + 'px';
        preview.style.left = currentImageRect.left + 'px';
        preview.style.top = currentImageRect.top + 'px';
        preview.style.transform = 'none';

        overlay.style.display = 'block';
        repositionWords();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function closeOverlay() {
    overlay.style.display = 'none';
    pendingBlob = null;
    pendingDisplaySize = null;
    pendingNaturalSize = null;
    currentImageRect = null;
  }

  escBtn.addEventListener('click', closeOverlay);

  let isUploading = false;

  async function submitUpload() {
    if (!pendingBlob || isUploading) return;

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

      const { data: inserted, error: insertError } = await supabase
        .from('images')
        .insert({
          url: publicData.publicUrl,
          natural_width: pendingNaturalSize.width,
          natural_height: pendingNaturalSize.height,
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
      });
    } finally {
      isUploading = false;
      submitBtn.style.pointerEvents = 'auto';
      submitBtn.style.opacity = '1';
    }
  }

  submitBtn.addEventListener('click', submitUpload);

  // [Enter] löst dieselbe Bestätigung aus wie der Klick auf "push" -- nur
  // während das Upload-Fenster offen ist.
  document.addEventListener('keydown', (e) => {
    if (overlay.style.display !== 'block' || e.key !== 'Enter') return;
    e.preventDefault();
    submitUpload();
  });

  return {
    handleFile: startUpload,
    // Für Fenstergrößenänderungen: nur die frei positionierten Textelemente
    // zurück in den sichtbaren Bereich holen — das Vorschaubild behält
    // seine ursprüngliche Größe.
    reposition: () => {
      if (overlay.style.display === 'block') repositionWords();
    },
  };
}

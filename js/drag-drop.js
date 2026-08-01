// Drag & Drop als zusätzlicher Upload-Weg — eine Datei irgendwo auf die
// Seite ziehen und loslassen öffnet direkt das Upload-Fenster, genau wie
// die Dateiauswahl über [push]. Die Dropzone ist die gesamte Seite.

function isFileDrag(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return !!types && Array.from(types).includes('Files');
}

export function initDragDrop({ onFileDropped, isDropAllowed }) {
  const overlay = document.getElementById('drop-overlay');
  let dragCounter = 0;

  function showOverlay() {
    overlay.classList.add('active');
  }

  function hideOverlay() {
    overlay.classList.remove('active');
    dragCounter = 0;
  }

  document.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragCounter++;
    showOverlay();
  });

  document.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // notwendig, damit "drop" überhaupt feuert
  });

  document.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) hideOverlay();
  });

  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    hideOverlay();

    if (!isDropAllowed()) return;

    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;

    onFileDropped(file);
  });
}

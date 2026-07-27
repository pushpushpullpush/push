import { computeLayout } from './layout-engine.js';

export function createGallery(stageEl, images) {
  const els = new Map();

  images.forEach((img) => {
    const el = document.createElement(img.url ? 'img' : 'div');
    el.className = 'push-image';
    el.dataset.imageId = img.id;
    el.style.width = img.width + 'px';
    el.style.height = img.height + 'px';
    if (img.url) {
      el.src = img.url;
    } else {
      el.style.background = img.color;
    }
    stageEl.appendChild(el);
    els.set(img.id, el);
  });

  function reshuffleImages() {
    const width = stageEl.clientWidth || 680;
    const { positions, totalHeight } = computeLayout(images, width);
    images.forEach((img) => {
      const el = els.get(img.id);
      const pos = positions.get(img.id);
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      el.style.zIndex = pos.z;
    });
    stageEl.style.minHeight = Math.max(totalHeight, window.innerHeight) + 'px';
  }

  reshuffleImages();

  return { reshuffleImages, elements: els };
}

// "*"-Modus — Einstieg bleibt geheim (nur per Taste), aber sobald man
// drin ist, erscheint das Element wieder, damit man per Klick zurückfindet.

export function initHideTextMode() {
  const el = document.createElement('div');
  el.id = 'star-toggle';
  el.className = 'menu-word';
  el.textContent = '*';
  el.style.position = 'fixed';
  el.style.right = '24px';
  el.style.bottom = '24px';
  el.style.zIndex = '9500';
  el.style.fontSize = '30px';
  document.body.appendChild(el);

  function toggle() {
    document.body.classList.toggle('hide-text');
  }

  el.addEventListener('click', toggle);

  return { toggle };
}

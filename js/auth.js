import { supabase } from './supabase-client.js';
import { randomSpot, clampToViewport, clampFromRect } from './position-utils.js';
import { repositionClock, setClockVisible } from './clock.js';
import { setShootWordVisible } from './shoot.js';
import { showMessage } from './notice-board.js';

const USERNAME_RE = /^[a-zA-Z0-9]{2,12}$/;

export function initAuth(refs, onSessionChange) {
  const {
    overlay, block, escBtn,
    usernameInput, passwordInput, passwordToggle, enterBtn,
    createToggle, signupFields, emailInput, newsletterToggle,
    forgotEl,
  } = refs;

  let currentUser = null; // { id, username } oder null
  let creatingAccount = false; // ersetzt die frühere Checkbox

  function setUser(user) {
    currentUser = user;
    onSessionChange(currentUser);
  }

  async function restoreSession() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, username, newsletter_opt_in')
      .eq('id', data.session.user.id)
      .single();

    if (profile) setUser(profile);
  }

  function resetForm() {
    usernameInput.value = '';
    passwordInput.value = '';
    passwordInput.type = 'password';
    passwordToggle.textContent = 'show';
    creatingAccount = false;
    createToggle.textContent = 'create account';
    signupFields.style.display = 'none';
    emailInput.value = '';
    newsletterToggle.checked = true;
  }

  /**
   * "forgot password" und "create account" schweben frei (wie andere
   * Textelemente der Seite), meiden dabei aber den Login-Block und halten
   * Mindestabstand zueinander sowie zu esc — sowohl bei der Anfangs-
   * platzierung als auch, falls der Block durch "create account" später
   * höher wird.
   */
  function repositionFloatingLinks(taken) {
    const blockRect = block.getBoundingClientRect();

    const forgotSpot = randomSpot(taken, { margin: 60, minDist: 160, avoidRect: blockRect });
    taken.push(forgotSpot);
    forgotEl.style.left = forgotSpot.x + 'px';
    forgotEl.style.top = forgotSpot.y + 'px';
    clampFromRect(forgotEl, blockRect, 24);
    clampToViewport(forgotEl);

    const createSpot = randomSpot(taken, { margin: 60, minDist: 160, avoidRect: blockRect });
    taken.push(createSpot);
    createToggle.style.left = createSpot.x + 'px';
    createToggle.style.top = createSpot.y + 'px';
    clampFromRect(createToggle, blockRect, 24);
    clampToViewport(createToggle);
  }

  function positionBlock() {
    const taken = [];
    // Größerer Rand-Abstand als anderswo: dieser Block kann durch "create
    // account" nachträglich deutlich höher werden, braucht also mehr Luft.
    const spot = randomSpot(taken, { margin: 150, minDist: 220 });
    block.style.left = spot.x + 'px';
    block.style.top = spot.y + 'px';
    clampToViewport(block, 40);
    taken.push(spot);

    const escSpot = randomSpot(taken, { margin: 100, minDist: 180 });
    escBtn.style.left = escSpot.x + 'px';
    escBtn.style.top = escSpot.y + 'px';
    clampToViewport(escBtn, 40);
    taken.push(escSpot);

    repositionFloatingLinks(taken);
    repositionClock(taken);
  }

  // Optionaler Callback: läuft NACH dem eigenen setShootWordVisible(true)
  // unten in close() — so kann ein Aufrufer (z.B. single-view.js, dessen
  // Shoot-Wort-Sichtbarkeit an einen eigenen Zustand gekoppelt ist statt
  // immer "sichtbar sobald nicht am Tippen") diese pauschale Annahme danach
  // gezielt wieder korrigieren, ohne dass jeder Aufrufer ohne diesen Bedarf
  // etwas ändern müsste.
  let pendingOnClosed = null;

  function open(onClosed) {
    resetForm();
    overlay.style.display = 'block';
    setShootWordVisible(false);
    setClockVisible(false);
    positionBlock();
    pendingOnClosed = onClosed || null;
  }

  function close() {
    overlay.style.display = 'none';
    setShootWordVisible(true);
    setClockVisible(true);
    const onClosed = pendingOnClosed;
    pendingOnClosed = null;
    if (onClosed) onClosed();
  }

  escBtn.addEventListener('click', close);

  function handleEnterKey(e) {
    if (e.key === 'Enter') enterBtn.click();
  }
  usernameInput.addEventListener('keydown', handleEnterKey);
  passwordInput.addEventListener('keydown', handleEnterKey);
  emailInput.addEventListener('keydown', handleEnterKey);

  passwordToggle.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    passwordToggle.textContent = showing ? 'show' : 'hide';
  });

  createToggle.addEventListener('click', () => {
    creatingAccount = !creatingAccount;
    createToggle.textContent = creatingAccount ? 'enter existing account' : 'create account';
    signupFields.style.display = creatingAccount ? 'flex' : 'none';

    // Der Block ist jetzt evtl. deutlich höher/niedriger geworden — zurück
    // ins Bild rücken und die frei schwebenden Links bei Bedarf wegschieben,
    // ohne sie komplett neu zu würfeln.
    requestAnimationFrame(() => {
      clampToViewport(block, 40);
      const blockRect = block.getBoundingClientRect();
      [forgotEl, createToggle].forEach((el) => {
        clampFromRect(el, blockRect, 24);
        clampToViewport(el);
      });
    });
  });

  forgotEl.addEventListener('click', async () => {
    const username = usernameInput.value.trim().toLowerCase();
    if (!username) {
      showMessage('error: enter your collection name first');
      return;
    }

    const { data: email, error } = await supabase.rpc('get_email_for_username', { uname: username });
    if (error || !email) {
      showMessage('error: wrong combination');
      return;
    }

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email);
    if (resetError) {
      showMessage('error: could not send reset mail');
      return;
    }
    showMessage('check your inbox');
  });

  async function performLogin() {
    const username = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    if (!username || !password) return;

    const { data: email, error: lookupError } = await supabase.rpc('get_email_for_username', { uname: username });

    if (lookupError || !email) {
      showMessage('error: wrong combination');
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      showMessage('error: wrong combination');
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, username, newsletter_opt_in')
      .eq('id', data.session.user.id)
      .single();

    if (profile) {
      setUser(profile);
      close();
    }
  }

  async function performSignup() {
    const username = usernameInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    const email = emailInput.value.trim();

    if (!USERNAME_RE.test(username)) {
      showMessage('error: collection name must be 2–12 letters/numbers');
      return;
    }
    if (!password) {
      showMessage('error: password required');
      return;
    }
    if (!email.includes('@') || !email.includes('.')) {
      showMessage('error: invalid e-mail');
      return;
    }

    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered')) {
        showMessage('error: e-mail already registered');
      } else if (msg.includes('password') || msg.includes('characters')) {
        showMessage('error: password too short');
      } else {
        showMessage('error: sign up failed');
      }
      return;
    }

    if (!data.user) {
      showMessage('error: sign up failed');
      return;
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: data.user.id,
        username,
        newsletter_opt_in: newsletterToggle.checked,
      });

    if (profileError) {
      const msg = (profileError.message || '').toLowerCase();
      if (msg.includes('duplicate') || msg.includes('unique')) {
        showMessage('collection name taken');
      } else {
        showMessage('error: sign up failed');
      }
      return;
    }

    setUser({ id: data.user.id, username, newsletter_opt_in: newsletterToggle.checked });
    close();
  }

  enterBtn.addEventListener('click', () => {
    if (creatingAccount) performSignup();
    else performLogin();
  });

  async function logout() {
    await supabase.auth.signOut();
    setUser(null);
  }

  restoreSession();

  return {
    open,
    close,
    logout,
    getCurrentUser: () => currentUser,
    // Für Fenstergrößenänderungen: Login-Block und frei schwebende Links
    // neu anordnen, nur wenn das Fenster gerade offen ist.
    reposition: () => {
      if (overlay.style.display === 'block') positionBlock();
    },
  };
}

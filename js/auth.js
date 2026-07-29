import { supabase } from './supabase-client.js';
import { randomSpot, clampToViewport } from './position-utils.js';
import { repositionClock } from './clock.js';
import { setShootWordVisible } from './shoot.js';

const USERNAME_RE = /^[a-zA-Z0-9]{2,12}$/;

export function initAuth(refs, onSessionChange) {
  const {
    overlay, block, escBtn,
    usernameInput, passwordInput, passwordToggle, loginBtn, loginError,
    createToggle, signupFields, emailInput, newsletterToggle,
    usernameTakenEl, signupError, signupBtn,
  } = refs;

  let currentUser = null; // { id, username } oder null

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
    createToggle.checked = false;
    signupFields.style.display = 'none';
    loginBtn.style.display = 'block';
    emailInput.value = '';
    newsletterToggle.checked = true;
    loginError.style.display = 'none';
    usernameTakenEl.style.display = 'none';
    signupError.style.display = 'none';
    if (forgotSentEl) forgotSentEl.style.display = 'none';
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

    repositionClock(taken);
  }

  function open() {
    resetForm();
    overlay.style.display = 'block';
    setShootWordVisible(false);
    positionBlock();
  }

  function close() {
    overlay.style.display = 'none';
    setShootWordVisible(true);
  }

  escBtn.addEventListener('click', close);

  function handleEnterKey(e) {
    if (e.key !== 'Enter') return;
    if (createToggle.checked) {
      signupBtn.click();
    } else {
      loginBtn.click();
    }
  }
  usernameInput.addEventListener('keydown', handleEnterKey);
  passwordInput.addEventListener('keydown', handleEnterKey);
  emailInput.addEventListener('keydown', handleEnterKey);

  passwordToggle.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    passwordToggle.textContent = showing ? 'show' : 'hide';
  });

  createToggle.addEventListener('change', () => {
    const creating = createToggle.checked;
    signupFields.style.display = creating ? 'flex' : 'none';
    loginBtn.style.display = creating ? 'none' : 'block';
    // Der Block ist jetzt evtl. deutlich höher geworden — zurück ins Bild rücken, falls nötig.
    requestAnimationFrame(() => clampToViewport(block, 40));
  });

  const { forgotEl, forgotSentEl } = refs;

  forgotEl && forgotEl.addEventListener('click', async () => {
    loginError.style.display = 'none';
    forgotSentEl.style.display = 'none';

    const username = usernameInput.value.trim();
    if (!username) {
      loginError.textContent = 'error: enter your username first';
      loginError.style.display = 'block';
      return;
    }

    const { data: email, error } = await supabase.rpc('get_email_for_username', { uname: username });
    if (error || !email) {
      loginError.style.display = 'block';
      return;
    }

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email);
    if (resetError) {
      loginError.textContent = 'error: could not send reset mail';
      loginError.style.display = 'block';
      return;
    }
    forgotSentEl.style.display = 'block';
  });

  loginBtn.addEventListener('click', async () => {
    loginError.style.display = 'none';
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) return;

    const { data: email, error: lookupError } = await supabase.rpc('get_email_for_username', { uname: username });

    if (lookupError || !email) {
      loginError.style.display = 'block';
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      loginError.style.display = 'block';
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
  });

  signupBtn.addEventListener('click', async () => {
    usernameTakenEl.style.display = 'none';
    signupError.style.display = 'none';

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const email = emailInput.value.trim();

    if (!USERNAME_RE.test(username)) {
      signupError.textContent = 'error: username must be 2–12 letters/numbers';
      signupError.style.display = 'block';
      return;
    }
    if (!password) {
      signupError.textContent = 'error: password required';
      signupError.style.display = 'block';
      return;
    }
    if (!email.includes('@') || !email.includes('.')) {
      signupError.textContent = 'error: invalid e-mail';
      signupError.style.display = 'block';
      return;
    }

    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered')) {
        signupError.textContent = 'error: e-mail already registered';
      } else if (msg.includes('password') || msg.includes('characters')) {
        signupError.textContent = 'error: password too short';
      } else {
        signupError.textContent = 'error: sign up failed';
      }
      signupError.style.display = 'block';
      return;
    }

    if (!data.user) {
      signupError.textContent = 'error: sign up failed';
      signupError.style.display = 'block';
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
        usernameTakenEl.style.display = 'block';
      } else {
        signupError.textContent = 'error: sign up failed';
        signupError.style.display = 'block';
      }
      return;
    }

    setUser({ id: data.user.id, username, newsletter_opt_in: newsletterToggle.checked });
    close();
  });

  async function logout() {
    await supabase.auth.signOut();
    setUser(null);
  }

  restoreSession();

  return { open, close, logout, getCurrentUser: () => currentUser };
}

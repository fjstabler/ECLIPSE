import { el, clear } from '../ui.js';
import { api } from '../api.js';
import { state } from '../state.js';

/**
 * Sign-in and first-run setup. On a fresh server this creates the
 * administrator; after that it's a profile picker plus a password box.
 */
export function AuthView({ onSignedIn }) {
  const root = el('div', { class: 'auth' });
  render();

  async function render() {
    const info = await api.me();
    const firstRun = info.firstRun;

    const errorBox = el('div', { class: 'auth__error', style: { display: 'none' } });
    const username = el('input', { class: 'input', autocomplete: 'username', placeholder: firstRun ? 'Choose a username' : 'Username' });
    const displayName = el('input', { class: 'input', placeholder: 'e.g. Finley' });
    const password = el('input', {
      class: 'input', type: 'password',
      autocomplete: firstRun ? 'new-password' : 'current-password',
      placeholder: firstRun ? 'Choose a password' : 'Password',
      onKeydown: (e) => { if (e.key === 'Enter') submit(); },
    });

    // Whether the chosen profile signs in with a PIN. Picking one that has a
    // PIN swaps the password box for a numeric one — four digits on a D-pad
    // rather than a password typed one letter at a time.
    let usingPin = false;
    const credentialLabel = el('label', {}, 'PASSWORD');
    const credentialField = el('div', { class: 'auth__field' }, credentialLabel, password);

    const useCredential = (pinMode) => {
      usingPin = pinMode;
      credentialLabel.textContent = pinMode ? 'PIN' : 'PASSWORD';
      password.placeholder = pinMode ? 'PIN' : (firstRun ? 'Choose a password' : 'Password');
      password.setAttribute('inputmode', pinMode ? 'numeric' : 'text');
      password.value = '';
    };

    const submitBtn = el('button', {
      class: 'btn btn--corona', type: 'button',
      style: { width: '100%', marginTop: '8px' },
      onClick: () => submit(),
    }, firstRun ? 'Create your profile' : 'Sign in');

    async function submit() {
      // Dismiss the on-screen keyboard the moment submission starts, not
      // whenever the network round-trip happens to finish — on Fire TV
      // there's nothing else that would close it, and leaving a focused
      // text field sitting there while a request is in flight is exactly
      // the kind of thing that reads as the app hanging.
      document.activeElement?.blur();
      errorBox.style.display = 'none';
      submitBtn.disabled = true;
      try {
        const body = {
          username: username.value.trim(),
          displayName: displayName.value.trim() || username.value.trim(),
          ...(usingPin ? { pin: password.value } : { password: password.value }),
        };
        const res = firstRun ? await api.setup(body) : await api.login(body);
        state.user = res.user;
        onSignedIn(res.user);
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.style.display = '';
        password.value = '';
        password.focus();
      } finally {
        submitBtn.disabled = false;
      }
    }

    const profiles = !firstRun && info.profiles?.length
      ? el('div', { class: 'auth__profiles' },
          info.profiles.map((p) =>
            el('button', {
              class: 'profilepick', type: 'button',
              onClick: () => { username.value = p.username; useCredential(Boolean(p.hasPin)); password.focus(); },
            },
              el('div', { class: 'profilepick__face', style: { background: p.avatarColor } },
                (p.displayName || p.username)[0].toUpperCase()),
              el('span', { class: 'profilepick__name' }, p.displayName),
              p.hasPin ? el('span', { class: 'profilepick__hint' }, 'PIN') : null)))
      : null;

    clear(root).append(
      el('div', { class: 'auth__card' },
        el('div', { class: 'auth__brand' },
          el('span', { class: 'brand__mark' }),
          el('span', { class: 'brand__word' }, 'ECLIPSE')),
        el('p', { class: 'auth__tag' },
          firstRun ? 'Set up your server' : 'Who is watching?'),
        errorBox,
        profiles,
        el('div', { class: 'auth__field' },
          el('label', {}, 'USERNAME'), username),
        firstRun
          ? el('div', { class: 'auth__field' }, el('label', {}, 'DISPLAY NAME'), displayName)
          : null,
        credentialField,
        submitBtn,
        firstRun
          ? el('p', { style: { fontSize: '12px', color: 'var(--text-faint)', marginTop: '18px', lineHeight: '1.55', textAlign: 'center' } },
              'This first profile is the administrator. You can add more for the rest of the household afterwards.')
          : null)
    );

    setTimeout(() => (firstRun || !info.profiles?.length ? username : password).focus(), 60);
  }

  return root;
}

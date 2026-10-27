const reset = location.pathname === '/admin/reset-password';
const form = document.getElementById(reset ? 'reset-password' : 'request-recovery');
document.getElementById('request-recovery').hidden = reset;
document.getElementById('reset-password').hidden = !reset;
if (reset) document.getElementById('instructions').textContent = 'Choose a unique password of at least 12 characters. The authentication service also enforces its configured password policy.';
if (new URLSearchParams(location.search).has('failed')) document.getElementById('status').textContent = 'The link could not be verified. Request a new link here and open it in this same browser.';
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button'); button.disabled = true;
  const status = document.getElementById('status');
  try {
    const data = Object.fromEntries(new FormData(form));
    if (reset && data.password !== data.confirmation) throw Error('Passwords do not match.');
    const csrf = document.cookie.split('; ').find(p => p.startsWith('__Host-cms-recovery-csrf='))?.split('=').slice(1).join('=');
    const response = await fetch(reset ? '/api/recovery/password' : '/api/recovery/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(reset ? { 'x-recovery-csrf': decodeURIComponent(csrf || '') } : {}) },
      body: JSON.stringify(reset ? { password: data.password } : { email: data.email }),
    });
    const result = await response.json();
    form.reset();
    if (!response.ok) throw Error(result.passwordUpdated ? 'Password updated, but session cleanup needs review before continuing.' : result.error || 'Request rejected.');
    status.textContent = reset ? 'Password updated. Return to sign in with your new password.' : 'If the address is eligible, a recovery link has been requested. Open the newest link in this browser.';
    if (reset) form.hidden = true;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});

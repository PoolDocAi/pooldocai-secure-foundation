/* Install the PoolDocAI troubleshooter as a PWA; never stores credentials here. */
(() => {
  let deferredPrompt = null;
  const buttons = () => [...document.querySelectorAll('[data-install-pooldocai-app]')];
  const say = (text) => {
    const target = document.getElementById('pooldocaiInstallStatus') || document.getElementById('appInstallStatus');
    if (target) target.textContent = text;
  };
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); deferredPrompt = event;
    buttons().forEach((button) => { button.disabled = false; button.textContent = 'Install PoolDocAI App'; });
    say('PoolDocAI is ready to install on this device.');
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null; say('PoolDocAI was installed successfully.');
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-install-pooldocai-app]');
    if (!button) return;
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const result = await deferredPrompt.userChoice;
        say(result?.outcome === 'accepted' ? 'Installation accepted. You can open PoolDocAI from your device home screen or app menu.' : 'Installation was cancelled. You can install later from your browser menu.');
      } catch { say('Use your browser menu to install or add PoolDocAI to your home screen.'); }
      deferredPrompt = null; return;
    }
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) say('On iPhone or iPad: open this page in Safari, tap Share, then choose “Add to Home Screen”.');
    else say('If your browser shows an install icon in the address bar, select it. Otherwise open the browser menu and choose “Install PoolDocAI” or “Install app”.');
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        // Older PoolDocAI builds registered technician-sw.js at the site root. Retire only
        // that known legacy root registration; keep the correctly scoped /technician worker.
        for (const registration of regs) {
          const scriptUrls = [registration.active, registration.waiting, registration.installing]
            .filter(Boolean).map(worker => worker.scriptURL);
          const isLegacyRootTechWorker = registration.scope === `${location.origin}/` &&
            scriptUrls.some(url => new URL(url).pathname === '/technician-sw.js');
          if (isLegacyRootTechWorker) await registration.unregister();
        }
        await navigator.serviceWorker.register('/app-sw.js', { scope: '/' });
      } catch (err) {
        console.warn('PoolDocAI app shell registration failed', err?.message || 'unknown error');
      }
    });
  }
})();

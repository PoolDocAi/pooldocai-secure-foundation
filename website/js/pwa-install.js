(()=>{
  'use strict';
  let installPrompt = null;
  const statusEl = () => document.getElementById('pooldocaiInstallStatus');
  const buttons = () => document.querySelectorAll('[data-install-pooldocai-app], [data-pwa-install]');
  function say(message) { const el=statusEl(); if(el) el.textContent=message; }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); installPrompt=event;
    buttons().forEach(button => { button.disabled=false; button.textContent='Install PoolDocAI App'; });
    say('PoolDocAI can be installed on this device. Select Install PoolDocAI App to continue.');
  });
  window.addEventListener('appinstalled', () => { installPrompt=null; say('PoolDocAI was installed on this device.'); });
  buttons().forEach(button => button.addEventListener('click', async () => {
    if (installPrompt) { installPrompt.prompt(); const choice=await installPrompt.userChoice; installPrompt=null; say(choice?.outcome==='accepted'?'PoolDocAI installation accepted.':'Installation dismissed. You can use the website normally.'); return; }
    const ua=navigator.userAgent||'';
    if (/iPhone|iPad|iPod/i.test(ua)) say('To install on iPhone or iPad, open PoolDocAI in Safari, tap Share, then Add to Home Screen.');
    else if (window.matchMedia('(display-mode: standalone)').matches) say('PoolDocAI is already running in app mode.');
    else say('Your browser does not currently offer direct installation. Use its menu and look for Install app or Add to Home Screen.');
  }));
})();

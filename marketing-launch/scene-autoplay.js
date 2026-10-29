/* Progressive enhancement for the three existing PoolDocAI scene dots.
   Only changes the highlighted scene; never scrolls the visitor's page. */
(() => {
  'use strict';
  const dots = [...document.querySelectorAll('.scene-controls [data-step]')];
  if (dots.length !== 3) return;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const intervalMs = 10000;
  const manualPauseMs = 20000;
  let timeout = null;

  const eligible = () => {
    if (document.hidden || motion.matches) return false;
    const focused = document.activeElement;
    return !focused?.closest?.('form, dialog, [role="dialog"], .resource-assistant');
  };

  const schedule = (delay = intervalMs) => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
    if (motion.matches || document.hidden) return;
    timeout = setTimeout(() => {
      if (!eligible()) return schedule(3000);
      const current = dots.findIndex(dot => dot.getAttribute('aria-pressed') === 'true');
      dots[(current + 1 + dots.length) % dots.length].click();
      schedule(intervalMs);
    }, delay);
  };

  // A real click selects immediately and allows time to read before autoplay resumes.
  for (const dot of dots) {
    dot.addEventListener('click', event => {
      if (event.isTrusted) schedule(manualPauseMs);
    });
  }
  document.addEventListener('visibilitychange', () => schedule(intervalMs));
  motion.addEventListener?.('change', () => schedule(intervalMs));
  schedule(intervalMs);
})();

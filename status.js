// Anzeige in der Handy-Version (oben rechts in der Ansicht): füllt den Offline-Speicher und zeigt Fortschritt und Stand.
(() => {
  // App ist angekommen: die Schleifensperre der Anmeldeseite (index.html) zurücksetzen
  try { sessionStorage.removeItem('weiter'); } catch { /* egal */ }
  const sw = navigator.serviceWorker;
  if (!sw?.controller) return;
  navigator.storage?.persist?.();
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;top:8px;right:8px;z-index:5;font:12px -apple-system,BlinkMacSystemFont,sans-serif;'
    + 'background:rgba(36,41,46,.86);color:#fff;padding:5px 10px;border-radius:12px;pointer-events:none;transition:opacity .6s';
  let weg = null;
  const stand = (s) => (s ? new Date(s).toLocaleString('de-AT', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  sw.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.typ !== 'sync') return;
    if (!el.isConnected) (document.querySelector('#stage') || document.body).appendChild(el);
    clearTimeout(weg); el.style.opacity = '1';
    if (m.gesamt && m.fertig < m.gesamt && !m.fehler) { el.textContent = `Offline speichern … ${Math.round((m.fertig / m.gesamt) * 100)} %`; return; }
    el.textContent = m.fehler ? `Offline · Stand ${stand(m.stand)}`.replace(/ · Stand $/, '') : `Offline bereit · Stand ${stand(m.stand)}`;
    weg = setTimeout(() => (el.style.opacity = '0'), 3500);
  });
  sw.controller.postMessage('sync');
})();

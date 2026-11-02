// Service Worker der Handy-Version (gebaut von tools/handy.mjs). Die App liegt verschlüsselt unter d/<id>; der Worker
// entschlüsselt sie beim Laden mit dem Schlüssel (nach der Passworteingabe gespeichert) und liefert sie unter app/ aus.
// Alles Geladene bleibt im Cache, damit die App auch ohne Netz geht. Platzhalter füllt der Build.
const SHELL = 'shell-b65ff6a6e30a', DATEN = 'daten', CDN = 'cdn', SCHLUESSEL = 'schluessel';
const CDN_DATEIEN = ["https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/math/SimplexNoise.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/objects/Sky.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/EffectComposer.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/GTAOPass.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/MaskPass.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/OutputPass.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/Pass.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/RenderPass.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/ShaderPass.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/shaders/CopyShader.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/shaders/GTAOShader.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/shaders/OutputShader.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/shaders/PoissonDenoiseShader.js","https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/utils/BufferGeometryUtils.js"];
const BASIS = new URL('./', self.location).href, BASIS_PFAD = new URL(BASIS).pathname;
const SHELL_DATEIEN = ['./', 'status.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'meta.json'];

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const c = await caches.open(SHELL);
  // einzeln: eine Datei, die gerade fehlt, darf den Worker nicht blockieren (sonst wartet die Anmeldung ewig)
  await Promise.allSettled(SHELL_DATEIEN.map(async (p) => { const r = await fetch(p, { cache: 'reload' }); if (r.ok) await c.put(p, r); }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![SHELL, DATEN, CDN, SCHLUESSEL].includes(k)) await caches.delete(k);
  await idb('readwrite', (s) => s.delete('schluessel')).catch(() => null);   // CryptoKey der ersten Version
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (CDN_DATEIEN.includes(url.href)) { e.respondWith(cdn(url.href)); return; }
  if (!url.href.startsWith(BASIS)) return;
  const pfad = url.pathname.slice(BASIS_PFAD.length);
  if (pfad === 'schluessel.bin') e.respondWith(new Response('', { status: 404 }));
  else if (pfad === 'app') e.respondWith(Response.redirect(BASIS + 'app/', 302));
  else if (pfad.startsWith('app/')) e.respondWith(app(decodeURIComponent(pfad.slice(4)) || 'index.html', req));
  else if (pfad === 'inhalt.bin') e.respondWith(fetch(req.url, { cache: 'no-cache' }).catch(() => caches.match(BASIS + 'inhalt.bin')));
  else if (!pfad.startsWith('d/')) e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});

self.addEventListener('message', (e) => {
  if (e.data === 'sync') e.waitUntil(sync(e.source).catch(() => e.source.postMessage({ typ: 'sync', fehler: true, stand: inhaltCache?.stand })));
});

// ---------- Schlüssel und Inhaltsverzeichnis ----------
// Der Schlüssel liegt als rohe Bytes zweimal: in IndexedDB (teilen Seite und Worker in Safari zuverlässig) und im Cache
// Storage. Die erste Version legte ein CryptoKey-Objekt in IndexedDB; das gab Safari am iPhone im Worker nicht heraus,
// und Anmeldeseite und Worker schickten sich endlos hin und her.
const SCHLUESSEL_URL = BASIS + 'schluessel.bin';
function db() {
  return new Promise((ok, fehler) => {
    const r = indexedDB.open('haus', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onsuccess = () => ok(r.result); r.onerror = () => fehler(r.error);
  });
}
async function idb(modus, f) {
  const d = await db();
  return new Promise((ok, fehler) => { const t = d.transaction('k', modus), r = f(t.objectStore('k')); t.oncomplete = () => ok(r?.result); t.onerror = () => fehler(t.error); });
}
async function schluessel() {
  let roh = await idb('readonly', (s) => s.get('roh')).catch(() => null);
  if (!roh) roh = await caches.open(SCHLUESSEL).then((c) => c.match(SCHLUESSEL_URL)).then((r) => r?.arrayBuffer()).catch(() => null);
  try { return roh ? await crypto.subtle.importKey('raw', roh, 'AES-GCM', false, ['decrypt']) : null; } catch { return null; }
}
const schluesselWeg = () => Promise.all([
  idb('readwrite', (s) => { s.delete('roh'); s.delete('schluessel'); }).catch(() => null), caches.delete(SCHLUESSEL).catch(() => null),
]);

async function entschluesseln(key, buf) {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
}

class FalscherSchluessel extends Error {}
let inhaltCache = null;

// Inhaltsverzeichnis (verschlüsselt): bei frisch=true zuerst aus dem Netz (höchstens 4 s), sonst aus dem Cache
async function inhalt(key, frisch) {
  if (inhaltCache && !frisch) return inhaltCache;
  let buf = null;
  if (frisch) {
    try {
      const r = await Promise.race([fetch(BASIS + 'inhalt.bin', { cache: 'no-cache' }), new Promise((_, f) => setTimeout(f, 4000))]);
      if (r.ok) buf = await r.arrayBuffer();
    } catch { /* offline: Cache */ }
  }
  const ausNetz = !!buf;
  if (!buf) buf = await (await caches.match(BASIS + 'inhalt.bin'))?.arrayBuffer();
  if (!buf) {
    if (inhaltCache) return inhaltCache;
    throw new Error('kein Inhaltsverzeichnis');
  }
  let idx;
  try { idx = JSON.parse(new TextDecoder().decode(await entschluesseln(key, buf))); } catch { throw new FalscherSchluessel(); }
  if (ausNetz) await (await caches.open(DATEN)).put(BASIS + 'inhalt.bin', new Response(buf));
  return (inhaltCache = idx);
}

async function blob(id) {
  const c = await caches.open(DATEN), url = BASIS + 'd/' + id;
  let r = await c.match(url);
  if (!r) {
    r = await fetch(url);
    if (!r.ok) throw new Error('fehlt ' + id);
    await c.put(url, r.clone());
  }
  return r.arrayBuffer();
}

// ---------- App ausliefern ----------
async function app(rel, req) {
  const navi = req.mode === 'navigate';
  // ?anmelden: die Anmeldeseite zeigt dann das Formular, statt gleich wieder hierher weiterzuleiten
  const zurLogin = () => (navi ? Response.redirect(BASIS + '?anmelden', 302) : new Response('', { status: 401 }));
  const key = await schluessel();
  if (!key) return zurLogin();
  let idx;
  try { idx = await inhalt(key, navi); } catch (err) {
    if (err instanceof FalscherSchluessel) { await schluesselWeg(); inhaltCache = null; return zurLogin(); }
    return new Response('Offline und noch nichts gespeichert.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const d = idx.dateien[rel];
  if (!d) return new Response('', { status: 404 });
  try {
    const klar = await entschluesseln(key, await blob(d.id));
    const body = d.z ? new Blob([klar]).stream().pipeThrough(new DecompressionStream('gzip')) : klar;
    return new Response(body, { headers: { 'Content-Type': d.typ } });
  } catch {
    return new Response('', { status: 504 });
  }
}

async function cdn(url) {
  const c = await caches.open(CDN);
  const r = await c.match(url, { ignoreVary: true });
  if (r) return r;
  const neu = await fetch(url);
  if (neu.ok) await c.put(url, neu.clone());
  return neu;
}

// ---------- Offline-Speicher füllen ----------
// Lädt alles, was fehlt (4 parallel), räumt Altes weg und meldet den Fortschritt an die Seite
async function sync(client) {
  const key = await schluessel();
  if (!key) return;
  const idx = await inhalt(key, true);
  const c = await caches.open(DATEN);
  const ids = new Set(Object.values(idx.dateien).map((d) => d.id));
  for (const r of await c.keys()) {
    const m = /\/d\/([0-9a-f]+)$/.exec(r.url);
    if (m && !ids.has(m[1])) await c.delete(r);
  }
  const fehlt = [];
  for (const id of ids) if (!(await c.match(BASIS + 'd/' + id))) fehlt.push(id);
  const cc = await caches.open(CDN);
  const cdnFehlt = [];
  for (const u of CDN_DATEIEN) if (!(await cc.match(u, { ignoreVary: true }))) cdnFehlt.push(u);
  const gesamt = ids.size + CDN_DATEIEN.length;
  let fertig = gesamt - fehlt.length - cdnFehlt.length, fehler = false;
  const melden = () => client.postMessage({ typ: 'sync', fertig, gesamt, fehler, stand: idx.stand });
  melden();
  const arbeit = [...fehlt.map((id) => () => blob(id)), ...cdnFehlt.map((u) => () => cdn(u))];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let a; (a = arbeit.shift());) {
      try { await a(); fertig++; } catch { fehler = true; }
      melden();
    }
  }));
  melden();
}

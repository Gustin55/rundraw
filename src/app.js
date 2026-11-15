// Interface : parcours guidé en 3 étapes (zone → dessin → parcours).

import { polylineLength } from './geo.js';
import { fetchStreets } from './osm.js';
import { toGPX } from './gpx.js';
import { SHAPES } from './shapes.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const MAX_SIDE_M = 6000;
const MIN_SIDE_M = 300;
const ROUTE_FACTOR = 1.15; // un parcours sur rues est en général un peu plus long que le dessin
const PAD = 0.12;          // marge autour du carré pour les rues téléchargées

const store = {
  get(k, d) { try { const v = localStorage.getItem('rundraw:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rundraw:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2).replace('.', ',') + ' km' : Math.round(m) + ' m');
const fmtMo = (b) => (b / 1048576).toFixed(1).replace('.', ',') + ' Mo';

// ---------- Carte ----------
const view = store.get('view', { lat: 48.8566, lon: 2.3522, z: 15 });
const map = L.map('map', { zoomSnap: 0, zoomDelta: 0.5, wheelPxPerZoomLevel: 120 }).setView([view.lat, view.lon], view.z);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const resultLayer = L.layerGroup().addTo(map);

map.on('moveend zoomend', () => {
  if (step === 'zone') {
    const c = map.getCenter();
    store.set('view', { lat: c.lat, lon: c.lng, z: map.getZoom() });
  }
  updateZoneInfo();
});

const handlers = ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard'];
const lockMap = (locked) => handlers.forEach((h) => map[h] && (locked ? map[h].disable() : map[h].enable()));

// ---------- Carré de dessin ----------
const wrap = $('map-wrap'), stencil = $('stencil'), canvas = $('canvas');
const ctx = canvas.getContext('2d');
let box = { left: 0, top: 0, side: 0 };
let strokes = store.get('strokes', []); // en coordonnées normalisées [0,1] dans le carré
let history = [];
let current = null;

function layoutStencil() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const side = Math.round(Math.min(w, h) * 0.82);
  box = { left: Math.round((w - side) / 2), top: Math.round((h - side) / 2), side };
  Object.assign(stencil.style, { left: box.left + 'px', top: box.top + 'px', width: side + 'px', height: side + 'px' });
  const dpr = window.devicePixelRatio || 1;
  canvas.width = side * dpr;
  canvas.height = side * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
  updateZoneInfo();
}

function redraw() {
  ctx.clearRect(0, 0, box.side, box.side);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#1c7ed6';
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(s[0][0] * box.side, s[0][1] * box.side);
    for (const [u, v] of s) ctx.lineTo(u * box.side, v * box.side);
    ctx.stroke();
  }
  if (!strokes.length && step === 'draw') {
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Dessine ici', box.side / 2, box.side / 2);
  }
  ctx.fillStyle = '#2b8a3e';
  if (strokes[0]?.length) {
    ctx.beginPath();
    ctx.arc(strokes[0][0][0] * box.side, strokes[0][0][1] * box.side, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  updateDrawLength();
}

function zoneSideMeters() {
  const y = box.top + box.side / 2;
  return map.distance(map.containerPointToLatLng([box.left, y]), map.containerPointToLatLng([box.left + box.side, y]));
}
const drawLengthMeters = () => strokes.reduce((s, p) => s + polylineLength(p), 0) * zoneSideMeters();

function updateZoneInfo() {
  if (!box.side) return;
  const m = zoneSideMeters();
  $('zone-size').textContent = fmtKm(m);
  const tooBig = m > MAX_SIDE_M, tooSmall = m < MIN_SIDE_M;
  $('to-draw').disabled = tooBig || tooSmall;
  $('to-draw').textContent = tooBig ? `Zone trop grande : zoome (max ${MAX_SIDE_M / 1000} km)` : tooSmall ? 'Zone trop petite : dézoome' : 'Dessiner dans cette zone →';
  updateDrawLength();
}
function updateDrawLength() {
  if (!box.side) return;
  const len = drawLengthMeters();
  $('draw-length').textContent = len ? '≈ ' + fmtKm(len * ROUTE_FACTOR) : '–';
}

const saveStrokes = () => store.set('strokes', strokes);
const pushHistory = () => { history.push(JSON.stringify(strokes)); if (history.length > 50) history.shift(); };

const toNorm = (e) => {
  const r = stencil.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
};
stencil.addEventListener('pointerdown', (e) => {
  if (step !== 'draw') return;
  stencil.setPointerCapture(e.pointerId);
  pushHistory();
  current = [toNorm(e)];
  strokes.push(current);
  e.preventDefault();
});
stencil.addEventListener('pointermove', (e) => {
  if (!current) return;
  const p = toNorm(e), q = current[current.length - 1];
  if (Math.hypot(p[0] - q[0], p[1] - q[1]) * box.side < 3) return;
  current.push(p);
  redraw();
});
const endStroke = () => {
  if (!current) return;
  if (current.length < 2) { strokes.pop(); history.pop(); }
  else {
    // Léger lissage du tremblement de la main (extrémités conservées).
    const s = current;
    for (let pass = 0; pass < 2; pass++)
      for (let i = 1; i < s.length - 1; i++)
        s[i] = [(s[i - 1][0] + 2 * s[i][0] + s[i + 1][0]) / 4, (s[i - 1][1] + 2 * s[i][1] + s[i + 1][1]) / 4];
  }
  current = null;
  saveStrokes();
  redraw();
};
stencil.addEventListener('pointerup', endStroke);
stencil.addEventListener('pointercancel', endStroke);

const undo = () => { if (history.length) { strokes = JSON.parse(history.pop()); saveStrokes(); redraw(); } };
$('undo').onclick = undo;
$('clear').onclick = () => { if (strokes.length) { pushHistory(); strokes = []; saveStrokes(); redraw(); } };
document.querySelectorAll('[data-shape]').forEach((b) => {
  b.onclick = () => { pushHistory(); strokes = SHAPES[b.dataset.shape](); saveStrokes(); redraw(); };
});
document.addEventListener('keydown', (e) => {
  if (step === 'draw' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
});
let lastWrap = '';
new ResizeObserver(() => {
  const k = wrap.clientWidth + 'x' + wrap.clientHeight;
  if (k === lastWrap) return;
  lastWrap = k;
  map.invalidateSize({ animate: false });
  layoutStencil();
  if (step === 'draw') restartPrefetch();
}).observe(wrap);

// ---------- Étapes ----------
let step = 'zone';
let zoneView = null;
let lastResult = null;

function goStep(next) {
  if (next === 'result' && !lastResult) return;
  if (next === 'draw' && step === 'zone') {
    if (zoneSideMeters() > MAX_SIDE_M || zoneSideMeters() < MIN_SIDE_M) return;
    zoneView = { center: map.getCenter(), zoom: map.getZoom() };
  }
  if (next === 'draw' && zoneView && step === 'result') map.setView(zoneView.center, zoneView.zoom, { animate: false });
  if (next !== 'result') resultLayer.clearLayers();
  if (next === 'result' && lastResult) drawResult(lastResult);
  step = next;
  document.body.dataset.step = next;
  lockMap(next === 'draw');
  $('stepper-result').disabled = !lastResult;
  setStatus('');
  if (next === 'draw') ensureStreets().catch(() => {});
  if (next === 'zone') cancelStreets();
  redraw();
}
document.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => goStep(b.dataset.goto)));
document.querySelector('[data-goto="result"]').id = 'stepper-result';
$('to-draw').onclick = () => goStep('draw');

function setStatus(msg, error = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', error);
}

// ---------- Recherche / position ----------
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (!q) return;
  setStatus('Recherche…');
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
    const [hit] = await r.json();
    if (!hit) return setStatus('Lieu introuvable.', true);
    map.setView([+hit.lat, +hit.lon], 15);
    setStatus('');
  } catch {
    setStatus('Recherche impossible (réseau ?).', true);
  }
});
$('locate').onclick = () => {
  setStatus('Localisation…');
  map.locate({ setView: true, maxZoom: 15 });
  map.once('locationfound', () => setStatus(''));
  map.once('locationerror', () => setStatus('Position indisponible.', true));
};

// ---------- Calcul en arrière-plan ----------
let worker, workerKey = null, pending = null;
function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  workerKey = null;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') return setBusy(null, m.text);
    const p = pending;
    pending = null;
    if (!p) return;
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => { if (pending) { pending.reject(new Error(e.message || 'Erreur de calcul')); pending = null; } };
}
startWorker();
const callWorker = (msg) => new Promise((resolve, reject) => { pending = { resolve, reject }; worker.postMessage(msg); });

// ---------- Rues (préchargées dès l'entrée dans l'étape dessin) ----------
let streets = null; // { bboxKey, promise, ctrl, label }

function currentZone() {
  const nw = map.containerPointToLatLng([box.left, box.top]);
  const se = map.containerPointToLatLng([box.left + box.side, box.top + box.side]);
  const c = map.containerPointToLatLng([box.left + box.side / 2, box.top + box.side / 2]);
  const pLat = (nw.lat - se.lat) * PAD, pLon = (se.lng - nw.lng) * PAD;
  const bbox = [se.lat - pLat, nw.lng - pLon, nw.lat + pLat, se.lng + pLon];
  return { bbox, bboxKey: bbox.map((v) => v.toFixed(4)).join(','), center: [c.lat, c.lng] };
}

function setPrefetch(text) { $('prefetch').textContent = text; streets && (streets.label = text); }

function ensureStreets() {
  const z = currentZone();
  if (streets && streets.bboxKey === z.bboxKey) return streets.promise;
  cancelStreets();
  const ctrl = new AbortController();
  const job = { bboxKey: z.bboxKey, ctrl, label: '' };
  streets = job;
  setPrefetch('Rues : connexion à OpenStreetMap…');
  job.promise = (async () => {
    const t0 = performance.now();
    const { key, text } = await fetchStreets(z.bbox, {
      signal: ctrl.signal,
      onStatus: (s) => {
        if (streets !== job) return;
        const t = s.phase === 'cache' ? 'Rues : en cache ✓'
          : s.phase === 'download' ? `Rues : téléchargement ${fmtMo(s.bytes)}…`
          : `Rues : en attente du serveur${s.servers > 1 ? ` (essai ${s.servers})` : ''}…`;
        setPrefetch(t);
        setBusy(null, t.replace('Rues : ', ''));
      },
    });
    if (ctrl.signal.aborted) throw new DOMException('Annulé', 'AbortError');
    if (workerKey !== key) {
      const m = await callWorker({ type: 'load', key, osmText: text, center: z.center });
      workerKey = key;
      if (streets === job) setPrefetch(`Rues prêtes ✓ (${m.nodes.toLocaleString('fr')} points, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    }
    return key;
  })();
  job.promise.catch((err) => {
    if (streets !== job || err.name === 'AbortError') return;
    setPrefetch('Rues : ' + err.message);
    streets = null; // permettra de réessayer
  });
  return job.promise;
}
function cancelStreets() {
  if (streets) streets.ctrl.abort();
  streets = null;
  $('prefetch').textContent = '';
}
let prefetchTimer;
function restartPrefetch() {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => ensureStreets().catch(() => {}), 600);
}

// ---------- Distance visée ----------
$('target').addEventListener('submit', (e) => {
  e.preventDefault();
  const km = parseFloat(String($('target-km').value).replace(',', '.'));
  const len = drawLengthMeters();
  if (!km || km <= 0) return setStatus('Indique une distance en km.', true);
  if (!len) return setStatus('Dessine d’abord quelque chose.', true);
  const factor = (km * 1000) / (len * ROUTE_FACTOR);
  const newSide = zoneSideMeters() * factor;
  if (newSide > MAX_SIDE_M) return setStatus(`Trop grand pour ce dessin (zone max ${MAX_SIDE_M / 1000} km). Dessine une forme plus longue ou vise moins de km.`, true);
  if (newSide < MIN_SIDE_M) return setStatus('Trop petit pour ce dessin.', true);
  map.setZoom(map.getZoom() - Math.log2(factor), { animate: false });
  zoneView = { center: map.getCenter(), zoom: map.getZoom() };
  setStatus('');
  updateZoneInfo();
  restartPrefetch();
});

// ---------- Génération ----------
let busyJob = 0;
function setBusy(text, sub) {
  const b = $('busy');
  if (text === false) { b.hidden = true; return; }
  if (b.hidden && text === null) return;
  b.hidden = false;
  if (text) $('busy-text').textContent = text;
  $('busy-sub').textContent = sub || '';
}
$('cancel').onclick = () => {
  busyJob++;
  cancelStreets();
  if (pending) { pending.reject(new DOMException('Annulé', 'AbortError')); pending = null; }
  worker.terminate();
  startWorker();
  setBusy(false);
  $('generate').disabled = false;
  setStatus('Annulé.');
};

async function plan(strokesLL) {
  const job = ++busyJob;
  $('generate').disabled = true;
  setBusy('Chargement des rues…', streets?.label?.replace('Rues : ', '') || '');
  try {
    const key = await ensureStreets();
    if (job !== busyJob) return;
    setBusy('Ajustement du dessin aux rues…', '');
    const r = await callWorker({
      type: 'plan', key, strokes: strokesLL,
      opts: { K: +$('opt-k').value, fit: $('opt-fit').checked, connect: $('opt-connect').checked, fitMaxScale: $('target-km').value ? 0.03 : 0.15 },
      targetM: parseFloat(String($('target-km').value).replace(',', '.')) * 1000 || 0,
    });
    if (job !== busyJob) return;
    lastResult = { ...r, strokesLL, connect: $('opt-connect').checked };
    goStep('result');
  } catch (err) {
    if (err.name !== 'AbortError' && job === busyJob) setStatus(err.message, true);
  } finally {
    if (job === busyJob) { setBusy(false); $('generate').disabled = false; }
  }
}

$('generate').onclick = () => {
  const valid = strokes.filter((s) => s.length >= 2);
  if (!valid.length) return setStatus('Dessine quelque chose d’abord (ou choisis une forme).', true);
  const toLL = ([u, v]) => {
    const ll = map.containerPointToLatLng([box.left + u * box.side, box.top + v * box.side]);
    return [ll.lat, ll.lng];
  };
  plan(valid.map((s) => s.map(toLL)));
};

$('opt-k').addEventListener('change', () => { if (lastResult && step === 'result') plan(lastResult.strokesLL); });

// ---------- Affichage du résultat ----------
function drawResult(r) {
  resultLayer.clearLayers();
  for (const s of r.fitted) L.polyline(s, { color: '#1c7ed6', weight: 3, opacity: 0.45 }).addTo(resultLayer);
  const all = [];
  for (const p of r.parts) {
    const style = p.type === 'link'
      ? { color: '#868e96', weight: 4, opacity: 0.9, dashArray: '6 8' }
      : { color: '#e8590c', weight: 5, opacity: 0.95 };
    L.polyline(p.coords, style).addTo(resultLayer);
    all.push(...p.coords);
  }
  // Bornes kilométriques.
  let acc = 0, nextKm = 1000;
  for (let i = 1; i < all.length; i++) {
    const d = map.distance(all[i - 1], all[i]);
    while (acc + d >= nextKm) {
      const t = (nextKm - acc) / d;
      const pt = [all[i - 1][0] + t * (all[i][0] - all[i - 1][0]), all[i - 1][1] + t * (all[i][1] - all[i - 1][1])];
      L.marker(pt, { interactive: false, icon: L.divIcon({ className: 'km-marker', html: String(nextKm / 1000), iconSize: [22, 18] }) }).addTo(resultLayer);
      nextKm += 1000;
    }
    acc += d;
  }
  const start = all[0], end = all[all.length - 1];
  L.circleMarker(start, { radius: 8, color: '#fff', weight: 2, fillColor: '#2b8a3e', fillOpacity: 1 }).bindTooltip('Départ', { permanent: true, direction: 'top', offset: [0, -8] }).addTo(resultLayer);
  if (map.distance(start, end) > 30)
    L.circleMarker(end, { radius: 8, color: '#fff', weight: 2, fillColor: '#c92a2a', fillOpacity: 1 }).bindTooltip('Arrivée', { direction: 'top' }).addTo(resultLayer);

  $('res-length').textContent = fmtKm(r.length);
  $('res-dev').textContent = Math.round(r.deviation) + ' m';
  $('res-fit').textContent = r.fit && (Math.abs(r.fit.s - 1) > 0.01 || Math.abs(r.fit.thDeg) >= 1)
    ? `Dessin ajusté : taille ×${r.fit.s.toFixed(2).replace('.', ',')}, rotation ${Math.round(r.fit.thDeg)}°.`
    : '';
}

$('download').onclick = () => {
  if (!lastResult) return;
  const { parts, connect } = lastResult;
  let segments;
  if (connect) {
    const all = [];
    for (const p of parts) for (const pt of p.coords) {
      const last = all[all.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) all.push(pt);
    }
    segments = [all];
  } else {
    segments = parts.filter((p) => p.type === 'stroke').map((p) => p.coords);
  }
  const blob = new Blob([toGPX(segments, 'RunDraw ' + new Date().toLocaleDateString('fr'))], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rundraw-${new Date().toISOString().slice(0, 10)}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- Démarrage ----------
layoutStencil();
goStep('zone');

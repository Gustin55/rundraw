// Interface : carte Leaflet, carré de dessin, génération et export.

import { makeProjection, polylineLength } from './geo.js';
import { buildGraph, SpatialIndex } from './graph.js';
import { planRoute } from './router.js';
import { toGPX } from './gpx.js';
import { SHAPES } from './shapes.js';

const L = window.L;
const $ = (id) => document.getElementById(id);

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const MAX_SIDE_M = 6000;

// ---------- Carte ----------
let view = { lat: 48.8566, lon: 2.3522, z: 15 };
try { view = JSON.parse(localStorage.getItem('rundraw:view')) || view; } catch { /* stockage indisponible */ }

const map = L.map('map', { zoomControl: true }).setView([view.lat, view.lon], view.z);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const resultLayer = L.layerGroup().addTo(map);

map.on('moveend', () => {
  const c = map.getCenter();
  try { localStorage.setItem('rundraw:view', JSON.stringify({ lat: c.lat, lon: c.lng, z: map.getZoom() })); } catch { /* ignore */ }
  updateZoneInfo();
});
map.on('zoomend', updateZoneInfo);

// ---------- Carré de dessin ----------
const wrap = $('map-wrap'), stencil = $('stencil'), canvas = $('canvas');
const ctx = canvas.getContext('2d');
let box = { left: 0, top: 0, side: 0 };
let strokes = []; // traits en coordonnées normalisées [0,1]
let current = null;

function layoutStencil() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const side = Math.round(Math.min(w, h) * 0.78);
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
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#1c7ed6';
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(s[0][0] * box.side, s[0][1] * box.side);
    for (const [u, v] of s) ctx.lineTo(u * box.side, v * box.side);
    ctx.stroke();
  }
  ctx.fillStyle = '#e8590c';
  for (const s of strokes) if (s.length) {
    ctx.beginPath();
    ctx.arc(s[0][0] * box.side, s[0][1] * box.side, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  updateDrawLength();
}

function zoneSideMeters() {
  const y = box.top + box.side / 2;
  const a = map.containerPointToLatLng([box.left, y]);
  const b = map.containerPointToLatLng([box.left + box.side, y]);
  return map.distance(a, b);
}
const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 1 : 2) + ' km' : Math.round(m) + ' m');

function updateZoneInfo() {
  if (!box.side) return;
  const m = zoneSideMeters();
  $('zone-size').textContent = fmtKm(m) + (m > MAX_SIDE_M ? ' (trop grand, zoome)' : '');
  updateDrawLength();
}
function updateDrawLength() {
  if (!box.side) return;
  const m = zoneSideMeters();
  const len = strokes.reduce((s, p) => s + polylineLength(p), 0) * m;
  $('draw-length').textContent = '≈ ' + fmtKm(len);
}

const toNorm = (e) => {
  const r = stencil.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
};
stencil.addEventListener('pointerdown', (e) => {
  if (!stencil.classList.contains('drawing')) return;
  stencil.setPointerCapture(e.pointerId);
  current = [toNorm(e)];
  strokes.push(current);
  e.preventDefault();
});
stencil.addEventListener('pointermove', (e) => {
  if (!current) return;
  const p = toNorm(e), q = current[current.length - 1];
  if (Math.hypot(p[0] - q[0], p[1] - q[1]) * box.side < 2) return;
  current.push(p);
  redraw();
});
const endStroke = () => {
  if (current && current.length < 2) strokes.pop();
  current = null;
  redraw();
};
stencil.addEventListener('pointerup', endStroke);
stencil.addEventListener('pointercancel', endStroke);

function setMode(draw) {
  stencil.classList.toggle('drawing', draw);
  $('mode-draw').classList.toggle('active', draw);
  $('mode-pan').classList.toggle('active', !draw);
}
$('mode-draw').onclick = () => setMode(true);
$('mode-pan').onclick = () => setMode(false);
$('undo').onclick = () => { strokes.pop(); redraw(); };
$('clear').onclick = () => { strokes = []; redraw(); };
document.querySelectorAll('[data-shape]').forEach((b) => {
  b.onclick = () => { strokes = SHAPES[b.dataset.shape](); redraw(); };
});
window.addEventListener('resize', layoutStencil);
layoutStencil();
setMode(true);

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
  map.locate({ setView: true, maxZoom: 16 });
  map.once('locationerror', () => setStatus('Position indisponible.', true));
};

// ---------- Données OSM ----------
const osmCache = new Map();
async function fetchStreets(s, w, n, e) {
  const key = [s, w, n, e].map((v) => v.toFixed(4)).join(',');
  if (osmCache.has(key)) return osmCache.get(key);
  const bbox = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:60];
way["highway"]["highway"!~"^(motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway|escape|abandoned|platform|corridor|elevator|busway)$"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"]["area"!="yes"](${bbox});
(._;>;);
out skel qt;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 70000);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      osmCache.set(key, json);
      return json;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------- Génération ----------
let lastResult = null;
const tick = () => new Promise((r) => setTimeout(r, 30));

function setStatus(msg, error = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', error);
}

$('generate').onclick = async () => {
  if (!strokes.some((s) => s.length >= 2)) return setStatus('Dessine quelque chose d’abord.', true);
  const side = zoneSideMeters();
  if (side > MAX_SIDE_M) return setStatus(`Zone trop grande (${fmtKm(side)}). Zoome un peu (max ${MAX_SIDE_M / 1000} km).`, true);
  if (side < 300) return setStatus('Zone trop petite, dézoome un peu.', true);

  const btn = $('generate');
  btn.disabled = true;
  try {
    const center = map.containerPointToLatLng([box.left + box.side / 2, box.top + box.side / 2]);
    const proj = makeProjection(center.lat, center.lng);
    const toXY = ([u, v]) => {
      const ll = map.containerPointToLatLng([box.left + u * box.side, box.top + v * box.side]);
      return proj.toXY(ll.lat, ll.lng);
    };
    const strokesXY = strokes.filter((s) => s.length >= 2).map((s) => s.map(toXY));

    const nw = map.containerPointToLatLng([box.left, box.top]);
    const se = map.containerPointToLatLng([box.left + box.side, box.top + box.side]);
    const padLat = (nw.lat - se.lat) * 0.25, padLon = (se.lng - nw.lng) * 0.25;

    setStatus('Téléchargement des rues (OpenStreetMap)…');
    await tick();
    const osm = await fetchStreets(se.lat - padLat, nw.lng - padLon, nw.lat + padLat, se.lng + padLon);

    setStatus('Construction du réseau…');
    await tick();
    const graph = buildGraph(osm, proj);
    if (graph.mainSize < 20) throw new Error('Pas assez de rues dans cette zone.');
    const index = new SpatialIndex(graph);

    setStatus('Ajustement du dessin aux rues…');
    await tick();
    const t0 = performance.now();
    const res = planRoute(graph, index, strokesXY, {
      K: +$('opt-k').value,
      fit: $('opt-fit').checked,
      connect: $('opt-connect').checked,
    });
    if (!res.parts.length) throw new Error('Impossible de suivre ce dessin ici.');
    lastResult = { res, graph, proj, connect: $('opt-connect').checked };
    showResult(lastResult);
    setStatus(`Calculé en ${((performance.now() - t0) / 1000).toFixed(1)} s · ${graph.mainSize.toLocaleString('fr')} intersections et points de rue.`);
  } catch (err) {
    console.error(err);
    setStatus('Erreur : ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
};

function showResult({ res, graph, proj }) {
  resultLayer.clearLayers();
  const ll = (nodes) => nodes.map((i) => [graph.lats[i], graph.lons[i]]);
  for (const s of res.fittedStrokes) {
    L.polyline(s.map(([x, y]) => proj.toLatLon(x, y)), { color: '#1c7ed6', weight: 3, opacity: 0.45 }).addTo(resultLayer);
  }
  for (const p of res.parts) {
    const style = p.type === 'link'
      ? { color: '#868e96', weight: 4, opacity: 0.9, dashArray: '6 8' }
      : { color: '#e8590c', weight: 5, opacity: 0.95 };
    L.polyline(ll(p.nodes), style).addTo(resultLayer);
  }
  const first = res.parts[0].nodes[0];
  L.circleMarker([graph.lats[first], graph.lons[first]], { radius: 7, color: '#fff', weight: 2, fillColor: '#2b8a3e', fillOpacity: 1 })
    .bindTooltip('Départ').addTo(resultLayer);

  stencil.classList.add('hidden');
  $('result').hidden = false;
  $('res-length').textContent = fmtKm(res.length);
  $('res-dev').textContent = Math.round(res.deviation) + ' m';
  $('res-fit').textContent = res.fit
    ? `Ajustement : taille ×${res.fit.params.s.toFixed(2)}, rotation ${Math.round(res.fit.params.thDeg)}°.`
    : '';
}

$('edit').onclick = () => {
  resultLayer.clearLayers();
  stencil.classList.remove('hidden');
  $('result').hidden = true;
  setStatus('');
};

$('download').onclick = () => {
  if (!lastResult) return;
  const { res, graph, connect } = lastResult;
  const ll = (nodes) => nodes.map((i) => [graph.lats[i], graph.lons[i]]);
  let segments;
  if (connect) {
    const all = [];
    for (const p of res.parts) for (const pt of ll(p.nodes)) {
      const last = all[all.length - 1];
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) all.push(pt);
    }
    segments = [all];
  } else {
    segments = res.parts.filter((p) => p.type === 'stroke').map((p) => ll(p.nodes));
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

// Test hors-ligne : réseau de rues synthétique + formes connues.
// Usage : node test/synthetic.mjs
import { makeProjection } from '../src/geo.js';
import { buildGraph, SpatialIndex } from '../src/graph.js';
import { planRoute } from '../src/router.js';
import { toGPX } from '../src/gpx.js';
import { heart, star } from '../src/shapes.js';

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function city(lat0, lon0, N = 40, spacing = 90) {
  const proj = makeProjection(lat0, lon0);
  const elements = [];
  const id = (i, j) => i * 1000 + j + 1;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = (i - N / 2) * spacing + (rnd() - 0.5) * 20;
    const y = (j - N / 2) * spacing + (rnd() - 0.5) * 20;
    const [lat, lon] = proj.toLatLon(x, y);
    elements.push({ type: 'node', id: id(i, j), lat, lon });
  }
  let w = 1;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (i + 1 < N && rnd() > 0.15) elements.push({ type: 'way', id: w++, nodes: [id(i, j), id(i + 1, j)] });
    if (j + 1 < N && rnd() > 0.15) elements.push({ type: 'way', id: w++, nodes: [id(i, j), id(i, j + 1)] });
    if (i + 1 < N && j + 1 < N && rnd() > 0.93) elements.push({ type: 'way', id: w++, nodes: [id(i, j), id(i + 1, j + 1)] });
  }
  return { proj, osm: { elements } };
}

const { proj, osm } = city(48.85, 2.35);
const t0 = performance.now();
const g = buildGraph(osm, proj);
const idx = new SpatialIndex(g);
console.log(`graphe : ${g.n} nœuds, composante principale ${g.mainSize}, ${(performance.now() - t0).toFixed(0)} ms`);

// Les formes sont en coordonnées normalisées [0,1] (y vers le bas, comme à l'écran).
const toXY = (strokes, side = 1500) => strokes.map((s) => s.map(([u, v]) => [(u - 0.5) * side, (0.5 - v) * side]));

let fail = 0;
for (const [name, shape] of [['coeur', heart()], ['etoile', star()], ['deux traits', [[[0.1, 0.2], [0.9, 0.25]], [[0.2, 0.8], [0.8, 0.6]]]]]) {
  for (const fit of [false, true]) {
    const t = performance.now();
    const r = planRoute(g, idx, toXY(shape), { fit });
    const ms = performance.now() - t;
    // Validité : chaque paire de nœuds consécutifs doit être reliée par une rue.
    let bad = 0;
    for (const p of r.parts) for (let k = 1; k < p.nodes.length; k++)
      if (!g.adj[p.nodes[k - 1]].some((e) => e.to === p.nodes[k])) bad++;
    const ok = bad === 0 && r.deviation < 40;
    if (!ok) fail++;
    console.log(`${ok ? 'OK ' : 'ÉCHEC'} ${name.padEnd(12)} fit=${fit ? 'oui' : 'non'}  ${(r.length / 1000).toFixed(2)} km  écart moyen ${r.deviation.toFixed(1)} m  sauts invalides ${bad}  ${ms.toFixed(0)} ms` +
      (r.fit ? `  (ajustement : x${r.fit.params.s.toFixed(2)}, ${r.fit.params.thDeg.toFixed(0)}°)` : ''));
  }
}
const r = planRoute(g, idx, toXY(heart()), {});
const gpx = toGPX([r.parts.flatMap((p) => p.nodes.map((i) => [g.lats[i], g.lons[i]]))], 'Coeur test');
if (!gpx.includes('<trkpt')) { console.log('ÉCHEC gpx'); fail++; }
process.exit(fail ? 1 : 0);

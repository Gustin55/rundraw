// Profilage sur un réseau dense réaliste (~ densité d'un centre-ville, rues avec points de forme).
import { makeProjection } from '../src/geo.js';
import { buildGraph, SpatialIndex } from '../src/graph.js';
import { planRoute } from '../src/router.js';
import { heart, star, smiley } from '../src/shapes.js';

export function denseCity(side = 4500, spacing = 70, shapeStep = 12, seed0 = 3) {
  let seed = seed0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const proj = makeProjection(48.85, 2.35);
  const els = []; let nid = 1, wid = 1;
  const N = Math.round(side / spacing);
  const P = [];
  for (let i = 0; i <= N; i++) { P.push([]); for (let j = 0; j <= N; j++) {
    const x = -side / 2 + i * spacing + (rnd() - .5) * spacing * .4, y = -side / 2 + j * spacing + (rnd() - .5) * spacing * .4;
    const [lat, lon] = proj.toLatLon(x, y); const id = nid++; els.push({ type: 'node', id, lat, lon }); P[i].push({ id, x, y });
  } }
  const way = (a, b) => { // rue avec points intermédiaires légèrement courbée
    const L = Math.hypot(b.x - a.x, b.y - a.y), k = Math.max(1, Math.round(L / shapeStep)), bend = (rnd() - .5) * 8;
    const nodes = [a.id];
    for (let s = 1; s < k; s++) { const t = s / k; const x = a.x + t * (b.x - a.x) - Math.sin(t * Math.PI) * bend * (b.y - a.y) / L, y = a.y + t * (b.y - a.y) + Math.sin(t * Math.PI) * bend * (b.x - a.x) / L;
      const [lat, lon] = proj.toLatLon(x, y); const id = nid++; els.push({ type: 'node', id, lat, lon }); nodes.push(id); }
    nodes.push(b.id); els.push({ type: 'way', id: wid++, nodes });
  };
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    if (i < N && rnd() > .2) way(P[i][j], P[i + 1][j]);
    if (j < N && rnd() > .2) way(P[i][j], P[i][j + 1]);
    if (i < N && j < N && rnd() > .9) way(P[i][j], P[i + 1][j + 1]);
  }
  return { proj, osm: { elements: els } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { proj, osm } = denseCity();
  let t = performance.now();
  const g = buildGraph(osm, proj); const idx = new SpatialIndex(g);
  console.log(`graphe ${g.n} nœuds : ${(performance.now() - t).toFixed(0)} ms`);
  const toXY = (s, side) => s.map((p) => p.map(([u, v]) => [(u - .5) * side, (.5 - v) * side]));
  for (const [name, sh] of [['coeur', heart()], ['etoile', star()], ['smiley', smiley()]]) for (const fit of [false, true]) {
    t = performance.now();
    const r = planRoute(g, idx, toXY(sh, 3000), { fit });
    console.log(`${name} fit=${fit}: ${(performance.now() - t).toFixed(0)} ms, ${(r.length / 1000).toFixed(1)} km, écart ${r.deviation.toFixed(0)} m`);
  }
}

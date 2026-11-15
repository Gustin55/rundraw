// Ajustement du dessin au réseau de rues.
//
// Principe :
//  1. Le trait est rééchantillonné finement, puis on y place des points de passage
//     (coins détectés par Douglas-Peucker + points réguliers).
//  2. Chaque point de passage est accroché au nœud de rue le plus proche.
//  3. Entre deux points de passage, on cherche un chemin A* dont le coût d'une rue
//     vaut   longueur × (1 + K × (écart au dessin / tolérance)²)
//     → le chemin préfère les rues qui suivent le dessin plutôt que le plus court.
//  4. On supprime les petits allers-retours (« éperons ») créés par l'accrochage.

import { dist, distToPolyline, polylineLength, resample, rdpIndices, transformPoints, bboxOf } from './geo.js';

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export class Router {
  constructor(graph, index) {
    this.g = graph;
    this.index = index;
    const n = graph.n;
    this.gs = new Float64Array(n);
    this.prev = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.run = 0;
  }

  /** A* de src à dst. edgeCost(a, b, len) >= len pour que l'heuristique reste admissible. */
  astar(src, dst, edgeCost, maxExpand = 400000) {
    if (src === dst) return [src];
    const g = this.g, gs = this.gs, prev = this.prev, stamp = this.stamp, closed = this.closed;
    const run = ++this.run;
    const tx = g.xs[dst], ty = g.ys[dst];
    const h = (i) => dist(g.xs[i], g.ys[i], tx, ty);
    const heap = new MinHeap();
    stamp[src] = run; gs[src] = 0; prev[src] = -1;
    heap.push(h(src), src);
    let expanded = 0;
    while (heap.size) {
      const u = heap.pop();
      if (closed[u] === run) continue;
      closed[u] = run;
      if (u === dst) break;
      if (++expanded > maxExpand) return null;
      const gu = gs[u];
      for (const e of g.adj[u]) {
        const w = e.to;
        if (closed[w] === run) continue;
        const ng = gu + edgeCost(u, w, e.len);
        if (stamp[w] !== run || ng < gs[w]) {
          stamp[w] = run; gs[w] = ng; prev[w] = u;
          heap.push(ng + h(w), w);
        }
      }
    }
    if (closed[dst] !== run) return null;
    const path = [];
    for (let u = dst; u !== -1; u = prev[u]) path.push(u);
    return path.reverse();
  }

  shortestPath(a, b) {
    return this.astar(a, b, (_u, _w, len) => len);
  }

  /**
   * Ajuste un trait (liste de points [x, y] en mètres) au réseau.
   * opts : { tol (m), K, step (m) }
   */
  matchStroke(pts, opts) {
    const g = this.g;
    const { tol, K } = opts;
    const dense = resample(pts, Math.max(2, tol / 6));
    const total = polylineLength(dense);
    const closedShape = dense.length > 2 &&
      dist(dense[0][0], dense[0][1], dense[dense.length - 1][0], dense[dense.length - 1][1]) < Math.max(2 * tol, total * 0.05);
    if (closedShape) dense[dense.length - 1] = dense[0].slice();

    // Points de passage : coins + points réguliers.
    const step = opts.step ?? Math.max(3 * tol, total / 80);
    const wp = new Set(rdpIndices(dense, tol * 0.8));
    let acc = 0;
    for (let i = 1; i < dense.length; i++) {
      acc += dist(dense[i - 1][0], dense[i - 1][1], dense[i][0], dense[i][1]);
      if (acc >= step) { wp.add(i); acc = 0; }
    }
    const wps = [...wp].sort((a, b) => a - b);

    // Accrochage aux nœuds.
    const snapped = [];
    for (const i of wps) {
      const s = this.index.nearestNode(dense[i][0], dense[i][1], Math.max(500, step * 4));
      if (!s) continue;
      if (snapped.length && snapped[snapped.length - 1].node === s.node) continue;
      snapped.push({ i, node: s.node });
    }
    if (snapped.length === 0) return null;
    if (snapped.length === 1) return { nodes: [snapped[0].node], closed: closedShape };

    const margin = Math.ceil(step / Math.max(2, tol / 6)) + 2;
    const capR2 = 25; // écart plafonné à 5 × tol
    const path = [snapped[0].node];
    for (let k = 1; k < snapped.length; k++) {
      const A = snapped[k - 1], B = snapped[k];
      const local = dense.slice(Math.max(0, A.i - margin), Math.min(dense.length, B.i + margin + 1));
      // Polyligne locale allégée pour le calcul des écarts.
      const poly = local.length > 40 ? local.filter((_, j) => j % 2 === 0 || j === local.length - 1) : local;
      const cache = new Map();
      const cost = (u, w, len) => {
        const key = u < w ? u * 4194304 + w : w * 4194304 + u;
        let f = cache.get(key);
        if (f === undefined) {
          const ns = Math.min(6, 1 + Math.floor(len / 15));
          let s = 0;
          for (let q = 0; q < ns; q++) {
            const t = (q + 0.5) / ns;
            const x = g.xs[u] + t * (g.xs[w] - g.xs[u]);
            const y = g.ys[u] + t * (g.ys[w] - g.ys[u]);
            const r = distToPolyline(x, y, poly) / tol;
            s += Math.min(r * r, capR2);
          }
          f = 1 + K * (s / ns);
          cache.set(key, f);
        }
        return len * f;
      };
      const seg = this.astar(A.node, B.node, cost) ?? this.shortestPath(A.node, B.node);
      if (!seg) continue;
      for (let j = 1; j < seg.length; j++) path.push(seg[j]);
    }
    return { nodes: removeSpurs(g, path, 3 * tol), closed: closedShape };
  }
}

/** Supprime les allers-retours X → Y → X dont la branche est plus courte que maxLen. */
export function removeSpurs(g, path, maxLen) {
  const out = [];
  for (const n of path) {
    if (out.length && out[out.length - 1] === n) continue;
    if (out.length >= 2 && out[out.length - 2] === n) {
      const y = out[out.length - 1];
      if (dist(g.xs[n], g.ys[n], g.xs[y], g.ys[y]) <= maxLen) { out.pop(); continue; }
    }
    out.push(n);
  }
  return out;
}

/** Score rapide d'un placement : écart quadratique moyen entre le dessin et la rue la plus proche. */
function placementScore(index, strokes, cap) {
  let s = 0, n = 0;
  for (const pts of strokes) for (const [x, y] of pts) {
    const d = index.nearestEdgeDist(x, y, cap);
    s += d * d; n++;
  }
  return n ? s / n : Infinity;
}

/**
 * Cherche une petite rotation / mise à l'échelle / translation du dessin
 * qui colle mieux au réseau local. Renvoie les traits transformés.
 */
export function autoFit(index, strokes, tol, { maxScale = 0.2, maxRot = 20, maxShift = 0.12 } = {}) {
  const samples = strokes.map((p) => resample(p, Math.max(tol / 2, 5)));
  const bb = bboxOf(strokes);
  const c = [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
  const size = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
  const cap = tol * 4;
  let best = { s: 1, th: 0, dx: 0, dy: 0 };
  let bestScore = placementScore(index, samples, cap);
  const baseScore = bestScore;
  const tryP = (p) => {
    const t = samples.map((pts) => transformPoints(pts, c, p.s, p.th, p.dx, p.dy));
    const sc = placementScore(index, t, cap);
    if (sc < bestScore) { bestScore = sc; best = p; }
  };
  // Recherche grossière puis affinage autour du meilleur.
  const scales = [1 - maxScale, 1 - maxScale / 2, 1, 1 + maxScale / 2, 1 + maxScale];
  const rots = [-maxRot, -maxRot / 2, 0, maxRot / 2, maxRot].map((d) => (d * Math.PI) / 180);
  const sh = size * maxShift;
  const shifts = [-sh, -sh / 2, 0, sh / 2, sh];
  for (const s of scales) for (const th of rots) for (const dx of shifts) for (const dy of shifts) tryP({ s, th, dx, dy });
  for (let it = 0; it < 2; it++) {
    const b = best, ds = maxScale / 4 / (it + 1), dth = (maxRot / 4 / (it + 1)) * Math.PI / 180, dd = sh / 4 / (it + 1);
    for (const s of [b.s - ds, b.s, b.s + ds]) for (const th of [b.th - dth, b.th, b.th + dth])
      for (const dx of [b.dx - dd, b.dx, b.dx + dd]) for (const dy of [b.dy - dd, b.dy, b.dy + dd]) tryP({ s, th, dx, dy });
  }
  return {
    strokes: strokes.map((pts) => transformPoints(pts, c, best.s, best.th, best.dx, best.dy)),
    params: { ...best, thDeg: (best.th * 180) / Math.PI },
    improvement: baseScore > 0 ? 1 - bestScore / baseScore : 0,
  };
}

/** Écart moyen (m) entre le parcours et le dessin, dans les deux sens. Entrées : listes de polylignes. */
export function deviation(routeLines, strokes) {
  const near = (x, y, lines) => {
    let best = Infinity;
    for (const l of lines) { const d = distToPolyline(x, y, l); if (d < best) best = d; }
    return best;
  };
  const avg = (A, B) => {
    const pts = A.flatMap((l) => resample(l, 10));
    return pts.reduce((s, [x, y]) => s + near(x, y, B), 0) / pts.length;
  };
  return (avg(routeLines, strokes) + avg(strokes, routeLines)) / 2;
}

/**
 * Pipeline complet : traits en mètres → parcours.
 * Renvoie { parts: [{ type: 'stroke'|'link', nodes }], length, deviation, fit }
 */
export function planRoute(graph, index, strokesXY, { tolerance, K = 3, fit = true, connect = true } = {}) {
  const router = new Router(graph, index);
  const bb = bboxOf(strokesXY);
  const size = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
  const tol = tolerance ?? Math.min(60, Math.max(12, size * 0.025));
  let strokes = strokesXY.filter((p) => p.length >= 2);
  let fitInfo = null;
  if (fit) {
    const f = autoFit(index, strokes, tol);
    strokes = f.strokes;
    fitInfo = f;
  }
  const parts = [];
  let prevEnd = null;
  for (const pts of strokes) {
    const m = router.matchStroke(pts, { tol, K });
    if (!m || m.nodes.length < 2) continue;
    if (connect && prevEnd !== null && prevEnd !== m.nodes[0]) {
      const link = router.shortestPath(prevEnd, m.nodes[0]);
      if (link) parts.push({ type: 'link', nodes: link });
    }
    parts.push({ type: 'stroke', nodes: m.nodes });
    prevEnd = m.nodes[m.nodes.length - 1];
  }
  const xy = (nodes) => nodes.map((i) => [graph.xs[i], graph.ys[i]]);
  const length = parts.reduce((s, p) => s + polylineLength(xy(p.nodes)), 0);
  const strokeParts = parts.filter((p) => p.type === 'stroke');
  const dev = strokeParts.length ? deviation(strokeParts.map((p) => xy(p.nodes)), strokes) : Infinity;
  return { parts, length, deviation: dev, tol, fit: fitInfo, fittedStrokes: strokes };
}

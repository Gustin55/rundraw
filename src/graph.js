// Construction du graphe piéton à partir d'une réponse Overpass + index spatial.

import { dist, distToSegment } from './geo.js';

/**
 * Construit un graphe non orienté à partir de la réponse JSON d'Overpass
 * (éléments "node" avec lat/lon et "way" avec la liste "nodes").
 * Seule la plus grande composante connexe est marquée comme utilisable (inMain).
 */
export function buildGraph(osm, proj) {
  const coords = new Map();
  for (const el of osm.elements) if (el.type === 'node') coords.set(el.id, el);

  const index = new Map();
  const xs = [], ys = [], lats = [], lons = [], adj = [];
  const getIdx = (id) => {
    let i = index.get(id);
    if (i !== undefined) return i;
    const n = coords.get(id);
    if (!n) return -1;
    i = xs.length;
    index.set(id, i);
    const [x, y] = proj.toXY(n.lat, n.lon);
    xs.push(x); ys.push(y); lats.push(n.lat); lons.push(n.lon); adj.push([]);
    return i;
  };

  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.nodes) continue;
    for (let k = 1; k < el.nodes.length; k++) {
      const a = getIdx(el.nodes[k - 1]), b = getIdx(el.nodes[k]);
      if (a < 0 || b < 0 || a === b) continue;
      if (adj[a].some((e) => e.to === b)) continue;
      const len = dist(xs[a], ys[a], xs[b], ys[b]);
      adj[a].push({ to: b, len });
      adj[b].push({ to: a, len });
    }
  }

  const n = xs.length;
  // Composantes connexes : on ne garde que la plus grande pour éviter de s'accrocher à un îlot isolé.
  const comp = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, c = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || adj[s].length === 0) continue;
    let size = 0;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const e of adj[u]) if (comp[e.to] < 0) { comp[e.to] = c; stack.push(e.to); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  const inMain = new Uint8Array(n);
  for (let i = 0; i < n; i++) inMain[i] = comp[i] === best ? 1 : 0;

  return { n, xs, ys, lats, lons, adj, inMain, mainSize: bestSize };
}

/** Grille de hachage pour retrouver vite le nœud ou la rue la plus proche d'un point. */
export class SpatialIndex {
  constructor(g, cell = 50) {
    this.g = g;
    this.cell = cell;
    this.nodes = new Map();
    this.edges = new Map();
    for (let i = 0; i < g.n; i++) {
      if (!g.inMain[i]) continue;
      this._add(this.nodes, this._key(this._c(g.xs[i]), this._c(g.ys[i])), i);
      for (const e of g.adj[i]) {
        if (e.to < i) continue;
        const j = e.to;
        const x0 = this._c(Math.min(g.xs[i], g.xs[j])), x1 = this._c(Math.max(g.xs[i], g.xs[j]));
        const y0 = this._c(Math.min(g.ys[i], g.ys[j])), y1 = this._c(Math.max(g.ys[i], g.ys[j]));
        for (let cx = x0; cx <= x1; cx++)
          for (let cy = y0; cy <= y1; cy++) this._add(this.edges, this._key(cx, cy), [i, j]);
      }
    }
  }
  _c(v) { return Math.floor(v / this.cell); }
  _key(cx, cy) { return cx * 1000003 + cy; }
  _add(map, k, v) { const l = map.get(k); if (l) l.push(v); else map.set(k, [v]); }

  /** Parcourt les cellules en anneaux croissants jusqu'à maxR. */
  _search(map, x, y, maxR, evalFn) {
    const cx = this._c(x), cy = this._c(y);
    const rings = Math.ceil(maxR / this.cell);
    let best = Infinity, bestItem = null;
    for (let r = 0; r <= rings; r++) {
      // Toute cellule de l'anneau r est à au moins (r-1)*cell du point.
      if (best <= (r - 1) * this.cell) break;
      for (let ix = cx - r; ix <= cx + r; ix++) {
        for (let iy = cy - r; iy <= cy + r; iy++) {
          if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy)) !== r) continue;
          const l = map.get(this._key(ix, iy));
          if (!l) continue;
          for (const item of l) {
            const d = evalFn(item);
            if (d < best) { best = d; bestItem = item; }
          }
        }
      }
    }
    return { d: best, item: bestItem };
  }

  nearestNode(x, y, maxR = 2000) {
    const g = this.g;
    const r = this._search(this.nodes, x, y, maxR, (i) => dist(x, y, g.xs[i], g.ys[i]));
    return r.item === null ? null : { node: r.item, d: r.d };
  }

  /** Distance à la rue la plus proche (plafonnée à maxR). */
  nearestEdgeDist(x, y, maxR = 300) {
    const g = this.g;
    const r = this._search(this.edges, x, y, maxR, ([a, b]) =>
      distToSegment(x, y, g.xs[a], g.ys[a], g.xs[b], g.ys[b]));
    return Math.min(r.d, maxR);
  }
}

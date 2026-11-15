// Géométrie de base : projection locale (mètres), distances, rééchantillonnage, simplification.

const R = 6371008.8;
const DEG = Math.PI / 180;

/** Projection équirectangulaire locale centrée sur (lat0, lon0), en mètres. Suffisant pour quelques km. */
export function makeProjection(lat0, lon0) {
  const kx = Math.cos(lat0 * DEG) * DEG * R;
  const ky = DEG * R;
  return {
    lat0, lon0,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

/** Distance d'un point au segment [a, b]. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance d'un point à une polyligne [[x,y], ...]. */
export function distToPolyline(px, py, poly) {
  if (poly.length === 1) return dist(px, py, poly[0][0], poly[0][1]);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const d = distToSegment(px, py, a[0], a[1], b[0], b[1]);
    if (d < best) best = d;
  }
  return best;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return L;
}

/** Rééchantillonne une polyligne à pas constant (le dernier point est conservé). */
export function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const seg = dist(ax, ay, bx, by);
    if (seg === 0) continue;
    let pos = step - carry;
    while (pos <= seg) {
      const t = pos / seg;
      out.push([ax + t * (bx - ax), ay + t * (by - ay)]);
      pos += step;
    }
    carry = seg - (pos - step);
  }
  const last = pts[pts.length - 1];
  const o = out[out.length - 1];
  if (dist(o[0], o[1], last[0], last[1]) > step * 0.25) out.push(last.slice());
  else out[out.length - 1] = last.slice();
  return out;
}

/** Douglas-Peucker : renvoie les indices conservés. */
export function rdpIndices(pts, eps) {
  const n = pts.length;
  if (n < 3) return [...Array(n).keys()];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[s][0], pts[s][1], pts[e][0], pts[e][1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Applique échelle s, rotation theta (rad) autour de c, puis translation (dx, dy). */
export function transformPoints(pts, c, s, theta, dx, dy) {
  const cos = Math.cos(theta) * s, sin = Math.sin(theta) * s;
  return pts.map(([x, y]) => {
    const u = x - c[0], v = y - c[1];
    return [c[0] + cos * u - sin * v + dx, c[1] + sin * u + cos * v + dy];
  });
}

export function bboxOf(pointLists) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of pointLists) for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

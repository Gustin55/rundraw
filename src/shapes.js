// Formes prédéfinies, en coordonnées normalisées [0,1] dans le carré (y vers le bas).

export function heart(n = 120) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * 2 * Math.PI;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([0.5 + x / 38, 0.47 - y / 38]);
  }
  return [pts];
}

export function star(branches = 5) {
  const pts = [];
  for (let k = 0; k <= branches * 2; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / branches;
    const r = k % 2 === 0 ? 0.42 : 0.17;
    pts.push([0.5 + r * Math.cos(a), 0.53 + r * Math.sin(a)]);
  }
  return [pts];
}

export function circle(n = 72) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * 2 * Math.PI;
    pts.push([0.5 + 0.38 * Math.cos(a), 0.5 + 0.38 * Math.sin(a)]);
  }
  return [pts];
}

export function smiley() {
  const c = circle()[0];
  const eye = (cx) => { const p = []; for (let k = 0; k <= 16; k++) { const a = (k / 16) * 2 * Math.PI; p.push([cx + 0.04 * Math.cos(a), 0.38 + 0.04 * Math.sin(a)]); } return p; };
  const mouth = []; for (let k = 0; k <= 24; k++) { const a = Math.PI * 0.15 + (k / 24) * Math.PI * 0.7; mouth.push([0.5 + 0.22 * Math.cos(a), 0.5 + 0.2 * Math.sin(a)]); }
  return [c, eye(0.38), eye(0.62), mouth];
}

export const SHAPES = { heart, star, circle, smiley };

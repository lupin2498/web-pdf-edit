// 2D affine matrices in PDF convention: [a b c d e f] maps (x, y) to
// (a*x + c*y + e, b*x + d*y + f). multiply(m1, m2) applies m1 first.

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function applyPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function translate(tx, ty) {
  return [1, 0, 0, 1, tx, ty];
}

export function scale(sx, sy) {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotateDeg(deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

// Normalized rectangle [x0, y0, x1, y1] with x0 <= x1 and y0 <= y1.
export function normRect(r) {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

export function transformRect(m, r) {
  const pts = [
    applyPoint(m, r[0], r[1]),
    applyPoint(m, r[2], r[1]),
    applyPoint(m, r[2], r[3]),
    applyPoint(m, r[0], r[3]),
  ];
  return boundsOfPoints(pts);
}

export function boundsOfPoints(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

export function rectContainsPoint(r, x, y, tol = 0) {
  return x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol;
}

export function rectsIntersect(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

export function rectContainsRect(outer, inner, tol = 0) {
  return (
    inner[0] >= outer[0] - tol &&
    inner[1] >= outer[1] - tol &&
    inner[2] <= outer[2] + tol &&
    inner[3] <= outer[3] + tol
  );
}

export function unionRect(a, b) {
  if (!a) return b ? b.slice() : null;
  if (!b) return a.slice();
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function rectArea(r) {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

export function intersectionRect(a, b) {
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  if (r[2] <= r[0] || r[3] <= r[1]) return null;
  return r;
}

// Matrix mapping rectangle `from` onto rectangle `to` (both normalized).
export function rectToRectMatrix(from, to) {
  const sx = (to[2] - to[0]) / (from[2] - from[0] || 1);
  const sy = (to[3] - to[1]) / (from[3] - from[1] || 1);
  return [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy];
}

export function matricesEqual(a, b, eps = 1e-6) {
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}

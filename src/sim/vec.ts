/**
 * 最小限のベクトルユーティリティ。
 *
 * シミュレーションのホットループでは Math.hypot を使わない。実装依存の精度を
 * 持つため決定論の保証が弱まる。Math.sqrt は IEEE754 で正確に定義される。
 */

export interface Vec {
  x: number;
  y: number;
}

export function vec(x = 0, y = 0): Vec {
  return { x, y };
}

export function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 線分 ab 上で点 p に最も近い点。 */
export function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Vec {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return { x: ax, y: ay };
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return { x: ax + abx * t, y: ay + aby * t };
}

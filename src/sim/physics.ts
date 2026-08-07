/**
 * 決定論的な剛体2D物理（並進＋回転）。
 *
 * 逐次インパルス法。Box2D-lite と同じ骨格で、
 *  - SAT で分離軸を求め、参照面／入射面のクリッピングで接触点を 1〜2 点作る
 *  - 蓄積インパルスをフレーム間で持ち越す（ウォームスタート）
 *  - めり込みは Baumgarte バイアスで解消する
 *
 * 決定論の担保:
 *  - 乱数を一切使わない。
 *  - 反復は常に配列順。接触の生成順もボディ配列順で決まる。
 *  - ホットループで Math.hypot を使わない（実装依存の精度を持つため）。
 *    Math.sqrt は IEEE754 で正確に定義される。
 *  - Math.sin/cos はボディの姿勢更新に使う。同一エンジン上では決定論的。
 */

import { length, type Vec } from './vec';

export const CAT_STATIC = 1;
export const CAT_DYNAMIC = 2;
export const CAT_ROPE = 4;
export const CAT_ACTOR = 8;
export const CAT_ALL = 0xffff;

export type ShapeKind = 'circle' | 'poly';

export interface Body {
  id: number;
  kind: ShapeKind;
  radius: number;
  /** 未回転のローカル頂点（多角形）。 */
  localVerts: Vec[];
  /** 未回転のローカル法線（多角形）。 */
  localNormals: Vec[];
  /** 現在の姿勢を反映したワールド頂点。 */
  world: Vec[];
  /** 現在の姿勢を反映したワールド法線。 */
  normals: Vec[];

  px: number;
  py: number;
  vx: number;
  vy: number;
  /** 姿勢（ラジアン）。 */
  angle: number;
  /** 角速度（ラジアン/秒）。 */
  av: number;

  invMass: number;
  /** 慣性モーメントの逆数。0 なら回転しない。 */
  invI: number;

  restitution: number;
  friction: number;
  isStatic: boolean;
  /** 上向きの浮力加速度 (px/s^2)。風船で使う。 */
  buoyancy: number;
  linearDamping: number;
  angularDamping: number;

  category: number;
  mask: number;
  /** true なら衝突応答をせず、重なりの検出のみ行う。 */
  sensor: boolean;
  tag: string;
  alive: boolean;
  owner: unknown;

  /**
   * 自走するボディ（歩く動物）の希望水平速度。
   *
   * 速度を直接代入すると、次のステップで摩擦ソルバが「滑り」とみなして
   * 打ち消してしまう。そこで摩擦の目標接線速度としてこれを解く。
   * 実際の歩行と同じく、地面を蹴る力は摩擦係数で頭打ちになるので、
   * 急な坂では自然に滑り落ちる。
   */
  driveVx: number;
  driveActive: boolean;
}

export interface ContactPoint {
  /** ワールド座標の接触点。 */
  x: number;
  y: number;
  depth: number;
  /** 蓄積した法線／接線インパルス（ウォームスタート用）。 */
  jn: number;
  jt: number;
  /** 面の組み合わせを表す ID。フレーム間で接触点を対応づけるのに使う。 */
  feature: number;
  // 以下はソルバが毎ステップ計算するキャッシュ。
  rax: number;
  ray: number;
  rbx: number;
  rby: number;
  massN: number;
  massT: number;
  bias: number;
  targetVn: number;
}

export interface Manifold {
  a: Body;
  b: Body;
  /** a から b へ向かう単位法線。 */
  nx: number;
  ny: number;
  points: ContactPoint[];
  /** 検出時点での法線方向の相対速度（負なら接近）。衝撃の強さ判定に使う。 */
  impact: number;
}

export interface Link {
  a: Body;
  b: Body;
  /** a のローカル座標系での接続点。 */
  ax: number;
  ay: number;
  /** b のローカル座標系での接続点。 */
  bx: number;
  by: number;
  rest: number;
  /** true: 距離を厳密に保つ / false: 伸びたときだけ引くロープ挙動。 */
  rigid: boolean;
  broken: boolean;
  owner: unknown;
}

interface BodyOptions {
  x: number;
  y: number;
  tag?: string;
  angle?: number;
  mass?: number;
  restitution?: number;
  friction?: number;
  isStatic?: boolean;
  buoyancy?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** true にすると回転しない（動物など、転倒してほしくないもの）。 */
  fixedRotation?: boolean;
  category?: number;
  mask?: number;
  sensor?: boolean;
  owner?: unknown;
}

let nextBodyId = 1;

/** 再現性を揃えたいとき（ヘッドレス検証など）に ID 採番を初期化する。 */
export function resetBodyIds(): void {
  nextBodyId = 1;
}

function baseBody(opts: BodyOptions): Body {
  const isStatic = opts.isStatic ?? false;
  const mass = opts.mass ?? 1;
  return {
    id: nextBodyId++,
    kind: 'circle',
    radius: 0,
    localVerts: [],
    localNormals: [],
    world: [],
    normals: [],
    px: opts.x,
    py: opts.y,
    vx: 0,
    vy: 0,
    angle: opts.angle ?? 0,
    av: 0,
    invMass: isStatic ? 0 : 1 / mass,
    invI: 0,
    restitution: opts.restitution ?? 0.05,
    friction: opts.friction ?? 0.6,
    isStatic,
    buoyancy: opts.buoyancy ?? 0,
    linearDamping: opts.linearDamping ?? 0.02,
    angularDamping: opts.angularDamping ?? 0.05,
    category: opts.category ?? (isStatic ? CAT_STATIC : CAT_DYNAMIC),
    mask: opts.mask ?? CAT_ALL,
    sensor: opts.sensor ?? false,
    tag: opts.tag ?? '',
    alive: true,
    owner: opts.owner ?? null,
    driveVx: 0,
    driveActive: false,
  };
}

export function createCircle(opts: BodyOptions & { radius: number }): Body {
  const b = baseBody(opts);
  b.kind = 'circle';
  b.radius = opts.radius;
  if (!b.isStatic && !opts.fixedRotation) {
    const mass = opts.mass ?? 1;
    b.invI = 1 / (0.5 * mass * opts.radius * opts.radius);
  }
  return b;
}

/** 中心 (x,y)、半幅 hw・半高 hh の矩形。 */
export function createBox(opts: BodyOptions & { hw: number; hh: number }): Body {
  const { hw, hh } = opts;
  return createPoly({
    ...opts,
    verts: [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ],
  });
}

/** 凸多角形。頂点は重心まわりのローカル座標、時計回り（y 下向き）で与える。 */
export function createPoly(opts: BodyOptions & { verts: Vec[] }): Body {
  const b = baseBody(opts);
  b.kind = 'poly';
  b.localVerts = opts.verts.map((v) => ({ x: v.x, y: v.y }));
  b.localNormals = buildNormals(b.localVerts);
  b.world = b.localVerts.map(() => ({ x: 0, y: 0 }));
  b.normals = b.localVerts.map(() => ({ x: 0, y: 0 }));
  if (!b.isStatic && !opts.fixedRotation) {
    const mass = opts.mass ?? 1;
    b.invI = 1 / (mass * polyInertiaPerMass(b.localVerts));
  }
  syncBody(b);
  return b;
}

function buildNormals(verts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % verts.length];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const len = length(ex, ey) || 1;
    // 頂点は時計回り（y 下向き座標系）。右手側が外向きになる。
    out.push({ x: ey / len, y: -ex / len });
  }
  return out;
}

/** 原点まわりの慣性モーメントを単位質量あたりで求める。 */
function polyInertiaPerMass(verts: Vec[]): number {
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % verts.length];
    const cross = Math.abs(p.x * q.y - p.y * q.x);
    numerator += cross * (p.x * p.x + p.x * q.x + q.x * q.x + p.y * p.y + p.y * q.y + q.y * q.y);
    denominator += cross;
  }
  if (denominator === 0) return 1;
  return numerator / (6 * denominator);
}

/** 姿勢からワールド頂点・法線を更新する。 */
export function syncBody(b: Body): void {
  if (b.kind !== 'poly') return;
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  for (let i = 0; i < b.localVerts.length; i++) {
    const v = b.localVerts[i];
    b.world[i].x = v.x * cos - v.y * sin + b.px;
    b.world[i].y = v.x * sin + v.y * cos + b.py;
    const n = b.localNormals[i];
    b.normals[i].x = n.x * cos - n.y * sin;
    b.normals[i].y = n.x * sin + n.y * cos;
  }
}

/** ローカル座標をワールド座標に変換する。 */
export function toWorld(b: Body, lx: number, ly: number): Vec {
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  return { x: lx * cos - ly * sin + b.px, y: lx * sin + ly * cos + b.py };
}

/** ワールド座標をローカル座標に変換する。 */
export function toLocal(b: Body, wx: number, wy: number): Vec {
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  const dx = wx - b.px;
  const dy = wy - b.py;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** ボディ上の点 (r は重心からのオフセット) における速度。v + ω × r。 */
function pointVelX(b: Body, ry: number): number {
  return b.vx - b.av * ry;
}
function pointVelY(b: Body, rx: number): number {
  return b.vy + b.av * rx;
}

// ---------------------------------------------------------------------------
// 衝突検出
// ---------------------------------------------------------------------------

function circleCircle(a: Body, b: Body): Manifold | null {
  const dx = b.px - a.px;
  const dy = b.py - a.py;
  const r = a.radius + b.radius;
  const dSq = dx * dx + dy * dy;
  if (dSq >= r * r) return null;
  const d = Math.sqrt(dSq);
  // 完全に重なった場合の縮退。乱数を使わず決め打ちの法線にする。
  const nx = d > 1e-9 ? dx / d : 0;
  const ny = d > 1e-9 ? dy / d : 1;
  return {
    a,
    b,
    nx,
    ny,
    impact: 0,
    points: [makePoint(a.px + nx * a.radius, a.py + ny * a.radius, r - d, 0)],
  };
}

function makePoint(x: number, y: number, depth: number, feature: number): ContactPoint {
  return {
    x,
    y,
    depth,
    jn: 0,
    jt: 0,
    feature,
    rax: 0,
    ray: 0,
    rbx: 0,
    rby: 0,
    massN: 0,
    massT: 0,
    bias: 0,
    targetVn: 0,
  };
}

/** 多角形 p 上で、方向 (dx,dy) に最も遠い頂点。 */
function support(p: Body, dx: number, dy: number): Vec {
  let best = p.world[0];
  let bestDot = best.x * dx + best.y * dy;
  for (let i = 1; i < p.world.length; i++) {
    const v = p.world[i];
    const d = v.x * dx + v.y * dy;
    if (d > bestDot) {
      bestDot = d;
      best = v;
    }
  }
  return best;
}

function circlePoly(c: Body, p: Body): Manifold | null {
  const verts = p.world;
  const n = verts.length;

  let bestFace = 0;
  let bestDist = -Infinity;
  for (let i = 0; i < n; i++) {
    const nm = p.normals[i];
    const d = nm.x * (c.px - verts[i].x) + nm.y * (c.py - verts[i].y);
    if (d > c.radius) return null; // 分離軸を発見
    if (d > bestDist) {
      bestDist = d;
      bestFace = i;
    }
  }

  const va = verts[bestFace];
  const vb = verts[(bestFace + 1) % n];

  if (bestDist < 1e-9) {
    // 中心が多角形の内部にある。最も浅い面から押し出す。
    const nm = p.normals[bestFace];
    return {
      a: c,
      b: p,
      nx: -nm.x,
      ny: -nm.y,
      impact: 0,
      points: [makePoint(c.px + nm.x * bestDist, c.py + nm.y * bestDist, c.radius - bestDist, bestFace)],
    };
  }

  // 中心は外部。最近接辺のどの領域にいるかで分ける。
  const ex = vb.x - va.x;
  const ey = vb.y - va.y;
  const lenSq = ex * ex + ey * ey || 1;
  let t = ((c.px - va.x) * ex + (c.py - va.y) * ey) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = va.x + ex * t;
  const cy = va.y + ey * t;
  const dx = c.px - cx;
  const dy = c.py - cy;
  const dSq = dx * dx + dy * dy;
  if (dSq > c.radius * c.radius) return null;
  const d = Math.sqrt(dSq);
  // 法線は c → p の向き（つまり接触点へ向かう向き）。
  const nx = d > 1e-9 ? -dx / d : p.normals[bestFace].x;
  const ny = d > 1e-9 ? -dy / d : p.normals[bestFace].y;
  return {
    a: c,
    b: p,
    nx,
    ny,
    impact: 0,
    points: [makePoint(cx, cy, c.radius - d, bestFace)],
  };
}

interface AxisQuery {
  index: number;
  separation: number;
}

/** a の各面について、b との分離量が最大になる面を返す。 */
function maxSeparation(a: Body, b: Body): AxisQuery {
  let bestIndex = 0;
  let bestSep = -Infinity;
  for (let i = 0; i < a.normals.length; i++) {
    const nm = a.normals[i];
    const s = support(b, -nm.x, -nm.y);
    const v = a.world[i];
    const sep = nm.x * (s.x - v.x) + nm.y * (s.y - v.y);
    if (sep > bestSep) {
      bestSep = sep;
      bestIndex = i;
    }
  }
  return { index: bestIndex, separation: bestSep };
}

/** 参照面の法線に最も逆向きな面を、入射多角形から選ぶ。 */
function incidentFace(inc: Body, refNx: number, refNy: number): number {
  let bestIndex = 0;
  let bestDot = Infinity;
  for (let i = 0; i < inc.normals.length; i++) {
    const nm = inc.normals[i];
    const d = nm.x * refNx + nm.y * refNy;
    if (d < bestDot) {
      bestDot = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** 線分を平面 (n, offset) の内側へクリップする。 */
function clipSegment(
  seg: [Vec, Vec],
  nx: number,
  ny: number,
  offset: number,
): [Vec, Vec] | null {
  const d0 = nx * seg[0].x + ny * seg[0].y - offset;
  const d1 = nx * seg[1].x + ny * seg[1].y - offset;
  const out: Vec[] = [];
  if (d0 <= 0) out.push(seg[0]);
  if (d1 <= 0) out.push(seg[1]);
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    out.push({
      x: seg[0].x + t * (seg[1].x - seg[0].x),
      y: seg[0].y + t * (seg[1].y - seg[0].y),
    });
  }
  if (out.length < 2) return null;
  return [out[0], out[1]];
}

function polyPoly(a: Body, b: Body): Manifold | null {
  const qa = maxSeparation(a, b);
  if (qa.separation > 0) return null;
  const qb = maxSeparation(b, a);
  if (qb.separation > 0) return null;

  // 参照面を選ぶ。わずかなバイアスで、面が拮抗するときのちらつきを抑える。
  let ref = a;
  let inc = b;
  let refIndex = qa.index;
  let flip = false;
  if (qb.separation > qa.separation + 0.01) {
    ref = b;
    inc = a;
    refIndex = qb.index;
    flip = true;
  }

  const refNorm = ref.normals[refIndex];
  const rv0 = ref.world[refIndex];
  const rv1 = ref.world[(refIndex + 1) % ref.world.length];

  const incIndex = incidentFace(inc, refNorm.x, refNorm.y);
  const iv0 = inc.world[incIndex];
  const iv1 = inc.world[(incIndex + 1) % inc.world.length];

  // 参照面に沿った接線方向で、両側の側面平面にクリップする。
  let tx = rv1.x - rv0.x;
  let ty = rv1.y - rv0.y;
  const tl = length(tx, ty) || 1;
  tx /= tl;
  ty /= tl;

  let seg: [Vec, Vec] | null = [
    { x: iv0.x, y: iv0.y },
    { x: iv1.x, y: iv1.y },
  ];
  seg = clipSegment(seg, -tx, -ty, -(tx * rv0.x + ty * rv0.y));
  if (!seg) return null;
  seg = clipSegment(seg, tx, ty, tx * rv1.x + ty * rv1.y);
  if (!seg) return null;

  const refOffset = refNorm.x * rv0.x + refNorm.y * rv0.y;
  const points: ContactPoint[] = [];
  for (let i = 0; i < 2; i++) {
    const sep = refNorm.x * seg[i].x + refNorm.y * seg[i].y - refOffset;
    if (sep <= 0) {
      // 面の組み合わせで ID を作り、フレーム間の対応づけに使う。
      points.push(makePoint(seg[i].x, seg[i].y, -sep, refIndex * 64 + incIndex * 4 + i));
    }
  }
  if (points.length === 0) return null;

  // 法線は常に a → b の向きに揃える。
  const nx = flip ? -refNorm.x : refNorm.x;
  const ny = flip ? -refNorm.y : refNorm.y;
  return { a, b, nx, ny, points, impact: 0 };
}

function collide(a: Body, b: Body): Manifold | null {
  if (a.kind === 'circle' && b.kind === 'circle') return circleCircle(a, b);
  if (a.kind === 'circle' && b.kind === 'poly') return circlePoly(a, b);
  if (a.kind === 'poly' && b.kind === 'circle') {
    const m = circlePoly(b, a);
    if (!m) return null;
    // circlePoly は (円, 多角形) 順で返すので a→b に反転する。
    return { a, b, nx: -m.nx, ny: -m.ny, points: m.points, impact: 0 };
  }
  return polyPoly(a, b);
}

function shouldCollide(a: Body, b: Body): boolean {
  if (!a.alive || !b.alive) return false;
  if (a.invMass === 0 && b.invMass === 0) return false;
  return (a.category & b.mask) !== 0 && (b.category & a.mask) !== 0;
}

// ---------------------------------------------------------------------------
// ワールド
// ---------------------------------------------------------------------------

export interface WorldOptions {
  gravity?: number;
  wind?: number;
  velocityIterations?: number;
}

const BAUMGARTE = 0.2;
const PENETRATION_SLOP = 0.5;
const RESTITUTION_THRESHOLD = 60;

export class World {
  bodies: Body[] = [];
  links: Link[] = [];
  contacts: Manifold[] = [];
  gravity: number;
  wind: number;
  private velocityIterations: number;
  /** 前ステップの接触。ウォームスタートのために蓄積インパルスを引き継ぐ。 */
  private previous = new Map<number, Manifold>();

  constructor(opts: WorldOptions = {}) {
    this.gravity = opts.gravity ?? 900;
    this.wind = opts.wind ?? 0;
    this.velocityIterations = opts.velocityIterations ?? 10;
  }

  add(b: Body): Body {
    this.bodies.push(b);
    return b;
  }

  /**
   * 2 つのボディを距離拘束で結ぶ。接続点はワールド座標で指定し、
   * 内部で各ボディのローカル座標に変換して保持する（回転に追従させるため）。
   */
  connect(
    a: Body,
    b: Body,
    opts: {
      anchorA?: Vec;
      anchorB?: Vec;
      rest?: number;
      rigid?: boolean;
      owner?: unknown;
    } = {},
  ): Link {
    const wa = opts.anchorA ?? { x: a.px, y: a.py };
    const wb = opts.anchorB ?? { x: b.px, y: b.py };
    const la = toLocal(a, wa.x, wa.y);
    const lb = toLocal(b, wb.x, wb.y);
    const link: Link = {
      a,
      b,
      ax: la.x,
      ay: la.y,
      bx: lb.x,
      by: lb.y,
      rest: opts.rest ?? length(wb.x - wa.x, wb.y - wa.y),
      rigid: opts.rigid ?? false,
      broken: false,
      owner: opts.owner ?? null,
    };
    this.links.push(link);
    return link;
  }

  remove(b: Body): void {
    b.alive = false;
    for (const l of this.links) {
      if (l.a === b || l.b === b) l.broken = true;
    }
  }

  compact(): void {
    this.bodies = this.bodies.filter((b) => b.alive);
    this.links = this.links.filter((l) => !l.broken);
  }

  step(dt: number): void {
    const bodies = this.bodies;
    const invDt = dt > 0 ? 1 / dt : 0;

    // 1. 外力を積分する。
    for (const b of bodies) {
      if (b.isStatic || !b.alive) continue;
      b.vy += (this.gravity - b.buoyancy) * dt;
      b.vx += this.wind * dt;
      const damp = 1 - b.linearDamping * dt;
      b.vx *= damp;
      b.vy *= damp;
      b.av *= 1 - b.angularDamping * dt;
    }

    // 2. 接触を検出する（総当たり）。
    for (const b of bodies) syncBody(b);
    const fresh: Manifold[] = [];
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (!shouldCollide(a, b)) continue;
        const m = collide(a, b);
        if (!m) continue;
        m.impact = (b.vx - a.vx) * m.nx + (b.vy - a.vy) * m.ny;
        fresh.push(m);
      }
    }

    // 3. 前ステップの蓄積インパルスを引き継ぐ（ウォームスタート）。
    const next = new Map<number, Manifold>();
    for (const m of fresh) {
      const key = m.a.id * 1000003 + m.b.id;
      const old = this.previous.get(key);
      if (old) {
        for (const p of m.points) {
          for (const q of old.points) {
            if (q.feature === p.feature) {
              p.jn = q.jn;
              p.jt = q.jt;
              break;
            }
          }
        }
      }
      next.set(key, m);
    }
    this.previous = next;
    this.contacts = fresh;

    // 4. 各接触点の実効質量とバイアスを前計算する。
    for (const m of this.contacts) {
      if (m.a.sensor || m.b.sensor) continue;
      this.prepareContact(m, invDt);
    }

    // 5. ウォームスタートのインパルスを適用する。
    for (const m of this.contacts) {
      if (m.a.sensor || m.b.sensor) continue;
      const tx = -m.ny;
      const ty = m.nx;
      for (const p of m.points) {
        const ix = m.nx * p.jn + tx * p.jt;
        const iy = m.ny * p.jn + ty * p.jt;
        applyImpulse(m.a, -ix, -iy, p.rax, p.ray);
        applyImpulse(m.b, ix, iy, p.rbx, p.rby);
      }
    }

    // 6. 速度を解く。反復順序は配列順に固定されており決定論的。
    for (let iter = 0; iter < this.velocityIterations; iter++) {
      for (const l of this.links) this.solveLink(l, invDt);
      for (const m of this.contacts) {
        if (m.a.sensor || m.b.sensor) continue;
        this.solveContact(m);
      }
    }

    // 7. 位置と姿勢を積分する。
    for (const b of bodies) {
      if (b.isStatic || !b.alive) continue;
      b.px += b.vx * dt;
      b.py += b.vy * dt;
      b.angle += b.av * dt;
    }
    for (const b of bodies) syncBody(b);
  }

  private prepareContact(m: Manifold, invDt: number): void {
    const { a, b, nx, ny } = m;
    const tx = -ny;
    const ty = nx;
    for (const p of m.points) {
      p.rax = p.x - a.px;
      p.ray = p.y - a.py;
      p.rbx = p.x - b.px;
      p.rby = p.y - b.py;

      const rnA = p.rax * ny - p.ray * nx;
      const rnB = p.rbx * ny - p.rby * nx;
      const kn = a.invMass + b.invMass + a.invI * rnA * rnA + b.invI * rnB * rnB;
      p.massN = kn > 0 ? 1 / kn : 0;

      const rtA = p.rax * ty - p.ray * tx;
      const rtB = p.rbx * ty - p.rby * tx;
      const kt = a.invMass + b.invMass + a.invI * rtA * rtA + b.invI * rtB * rtB;
      p.massT = kt > 0 ? 1 / kt : 0;

      // めり込みを押し戻すバイアス速度。
      p.bias = BAUMGARTE * invDt * Math.max(0, p.depth - PENETRATION_SLOP);

      // 反発。低速では切って、静止時のぷるぷるを防ぐ。
      // ばね (restitution > 1) を成立させるため min ではなく max を採る。
      const rvx = pointVelX(b, p.rby) - pointVelX(a, p.ray);
      const rvy = pointVelY(b, p.rbx) - pointVelY(a, p.rax);
      const vn = rvx * nx + rvy * ny;
      const e = Math.max(a.restitution, b.restitution);
      p.targetVn = vn < -RESTITUTION_THRESHOLD ? -e * vn : 0;
    }
  }

  private solveContact(m: Manifold): void {
    const { a, b, nx, ny } = m;
    const tx = -ny;
    const ty = nx;
    const mu = Math.sqrt(a.friction * b.friction);

    for (const p of m.points) {
      // 法線方向。
      let rvx = pointVelX(b, p.rby) - pointVelX(a, p.ray);
      let rvy = pointVelY(b, p.rbx) - pointVelY(a, p.rax);
      const vn = rvx * nx + rvy * ny;
      let dJn = (p.targetVn - vn + p.bias) * p.massN;
      // 蓄積インパルスは常に非負（引っ張らない）。
      const newJn = Math.max(0, p.jn + dJn);
      dJn = newJn - p.jn;
      p.jn = newJn;
      applyImpulse(a, -nx * dJn, -ny * dJn, p.rax, p.ray);
      applyImpulse(b, nx * dJn, ny * dJn, p.rbx, p.rby);

      // 接線方向（クーロン摩擦を蓄積インパルスのクランプで近似）。
      rvx = pointVelX(b, p.rby) - pointVelX(a, p.ray);
      rvy = pointVelY(b, p.rbx) - pointVelY(a, p.rax);
      const vt = rvx * tx + rvy * ty;
      // 通常は相対接線速度を 0 に近づける（＝滑りを止める）。ただし自走する
      // ボディが絡む場合は、その希望速度になるように目標をずらす。
      let targetVt = 0;
      if (a.driveActive) targetVt = (b.vx - a.driveVx) * tx + (b.vy - a.vy) * ty;
      else if (b.driveActive) targetVt = (b.driveVx - a.vx) * tx + (b.vy - a.vy) * ty;
      let dJt = (targetVt - vt) * p.massT;
      const maxJt = mu * p.jn;
      const newJt = Math.min(maxJt, Math.max(-maxJt, p.jt + dJt));
      dJt = newJt - p.jt;
      p.jt = newJt;
      applyImpulse(a, -tx * dJt, -ty * dJt, p.rax, p.ray);
      applyImpulse(b, tx * dJt, ty * dJt, p.rbx, p.rby);
    }
  }

  private solveLink(l: Link, invDt: number): void {
    if (l.broken || !l.a.alive || !l.b.alive) return;
    const { a, b } = l;
    const pa = toWorld(a, l.ax, l.ay);
    const pb = toWorld(b, l.bx, l.by);
    let dx = pb.x - pa.x;
    let dy = pb.y - pa.y;
    const d = length(dx, dy);
    if (d < 1e-9) return;
    const c = d - l.rest;
    // ロープは伸びたときだけ引く。縮む方向には拘束しない。
    if (!l.rigid && c < 0) return;

    dx /= d;
    dy /= d;
    const rax = pa.x - a.px;
    const ray = pa.y - a.py;
    const rbx = pb.x - b.px;
    const rby = pb.y - b.py;
    const rnA = rax * dy - ray * dx;
    const rnB = rbx * dy - rby * dx;
    const k = a.invMass + b.invMass + a.invI * rnA * rnA + b.invI * rnB * rnB;
    if (k <= 0) return;

    const rvx = pointVelX(b, rby) - pointVelX(a, ray);
    const rvy = pointVelY(b, rbx) - pointVelY(a, rax);
    const vn = rvx * dx + rvy * dy;
    const bias = BAUMGARTE * invDt * c;
    const j = -(vn + bias) / k;

    applyImpulse(a, -dx * j, -dy * j, rax, ray);
    applyImpulse(b, dx * j, dy * j, rbx, rby);
  }

  /**
   * body の足元に接触があるか。歩行エージェントの接地判定に使う。
   * 法線は a→b 向きなので、自分が a なら +y、b なら -y が「下向き」。
   */
  groundContact(body: Body): { other: Body; nx: number; ny: number } | null {
    for (const m of this.contacts) {
      if (m.a.sensor || m.b.sensor) continue;
      if (m.a === body && m.ny > 0.5) return { other: m.b, nx: m.nx, ny: m.ny };
      if (m.b === body && m.ny < -0.5) return { other: m.a, nx: -m.nx, ny: -m.ny };
    }
    return null;
  }

  /** body に接触している相手の一覧（法線は body から相手へ向く向きに揃える）。 */
  *touching(body: Body): Generator<{ other: Body; nx: number; ny: number; impact: number }> {
    for (const m of this.contacts) {
      if (m.a === body) yield { other: m.b, nx: m.nx, ny: m.ny, impact: m.impact };
      else if (m.b === body) yield { other: m.a, nx: -m.nx, ny: -m.ny, impact: m.impact };
    }
  }
}

function applyImpulse(b: Body, ix: number, iy: number, rx: number, ry: number): void {
  if (b.invMass === 0 && b.invI === 0) return;
  b.vx += ix * b.invMass;
  b.vy += iy * b.invMass;
  b.av += b.invI * (rx * iy - ry * ix);
}

/**
 * Canvas 描画。
 *
 * 画像アセットは一切持たず、すべて手続き的に描く（原作の素材は流用できないため）。
 * 描画対象は常に Simulation。配置フェーズでは「1 ステップも進めていない
 * Simulation」を描いているだけなので、配置画面と実行画面で見た目がずれない。
 */

import type { Body } from '../sim/physics';
import type { AnchorInfo, BirdEntity, Simulation, WalkerEntity } from '../sim/simulation';
import type { ItemId, PropDef, StageDef, TerrainDef } from '../sim/types';
import { ITEMS } from '../sim/items';
import { THEMES, hashSeed, makeRng, type Theme } from './theme';
import type { SpriteSet } from './sprites';
import type { RigSet } from './rig';

export interface Ghost {
  item: ItemId;
  x: number;
  y: number;
  angle: number;
  valid: boolean;
}

export interface RenderState {
  phase: 'place' | 'run';
  ghost: Ghost | null;
  /** ロープ接続中に光らせる接続点。 */
  anchors: AnchorInfo[];
  ropeFrom: AnchorInfo | null;
  pointer: { x: number; y: number } | null;
  selectedId: string | null;
  /** 演出用の実時間（秒）。 */
  clock: number;
}

interface Effect {
  kind: 'explosion' | 'pop' | 'spark';
  x: number;
  y: number;
  r: number;
  life: number;
  max: number;
}

/** キャラクターの輪郭色。濃い輪郭が原作の手描き調の要になっている。 */
const INK = '#2b1206';
/** 当たり判定は変えずに、見た目だけ一回り大きくする倍率。 */
const TIGER_SCALE = 1.35;
const BIRD_SCALE = 1.25;

/** 論理座標 (800x600) と画面ピクセルの対応。 */
export interface Viewport {
  scale: number;
  ox: number;
  oy: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private effects: Effect[] = [];
  view: Viewport = { scale: 1, ox: 0, oy: 0 };
  /**
   * 描画の優先順位: リグ（1枚絵＋関節） → スプライトシート → 手続き的描画。
   * どれも用意が無ければ手続き的描画になるので、絵が無くても遊べる。
   */
  rigs: RigSet = new Map();
  sprites: SpriteSet = new Map();

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D コンテキストを取得できませんでした');
    this.ctx = ctx;
  }

  /** キャンバスを実サイズに合わせ、論理座標との対応を作る（レターボックス）。 */
  resize(stage: StageDef): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const { w: lw, h: lh } = stage.world.bounds;
    const scale = Math.min(rect.width / lw, rect.height / lh);
    this.view = {
      scale,
      ox: (rect.width - lw * scale) / 2,
      oy: (rect.height - lh * scale) / 2,
    };
  }

  /** 画面座標 → 論理座標。 */
  toLogical(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const { scale, ox, oy } = this.view;
    return {
      x: (clientX - rect.left - ox) / scale,
      y: (clientY - rect.top - oy) / scale,
    };
  }

  addEffect(kind: Effect['kind'], x: number, y: number, r: number): void {
    const max = kind === 'explosion' ? 0.5 : 0.35;
    this.effects.push({ kind, x, y, r, life: max, max });
  }

  draw(sim: Simulation, state: RenderState, dt: number): void {
    const ctx = this.ctx;
    const stage = sim.stage;
    const theme = THEMES[stage.biome];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rect = this.canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#0d0715';
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.translate(this.view.ox, this.view.oy);
    ctx.scale(this.view.scale, this.view.scale);
    const { w, h } = stage.world.bounds;
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    this.drawBackground(stage, theme);
    for (const t of stage.terrain) this.drawTerrain(t, theme);
    for (const p of stage.props ?? []) this.drawProp(p, theme, state.clock);

    this.drawRopes(sim, theme);
    this.drawBodies(sim, theme, state);
    this.drawBirds(sim, state.clock);
    this.drawWalkers(sim, state.clock);

    this.updateEffects(dt);
    this.drawEffects();
    this.drawPlacementAids(state, theme);

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 背景
  // -------------------------------------------------------------------------

  private drawBackground(stage: StageDef, theme: Theme): void {
    const ctx = this.ctx;
    const { w, h } = stage.world.bounds;

    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, theme.skyTop);
    sky.addColorStop(0.55, theme.skyBottom);
    sky.addColorStop(1, theme.near);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // 月明かりのにじみ。
    const glow = ctx.createRadialGradient(w * 0.62, h * 0.12, 0, w * 0.62, h * 0.12, h * 0.7);
    glow.addColorStop(0, this.alpha(theme.haze, 0.34));
    glow.addColorStop(1, this.alpha(theme.haze, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // 奥・中景のシルエット。シードを固定しているので毎フレーム同じ絵になる。
    const rng = makeRng(hashSeed(stage.id));
    this.drawCanopyLayer(rng, w, h, theme.far, h * 0.30, 62, 15);
    this.drawCanopyLayer(rng, w, h, theme.mid, h * 0.20, 48, 13);

    // ジャングルの主役である大木。当たり判定は持たない背景。
    if (stage.biome === 'amazon') this.drawBigTree(w, h, theme);

    // 樹冠。風船がここまで浮上して止まる、という手がかりになる。
    this.drawCanopyBand(rng, w, theme);
  }

  private drawBigTree(w: number, h: number, theme: Theme): void {
    const ctx = this.ctx;
    const cx = w * 0.46;

    const trunk = ctx.createLinearGradient(cx - 46, 0, cx + 46, 0);
    trunk.addColorStop(0, theme.woodDark);
    trunk.addColorStop(0.35, theme.wood);
    trunk.addColorStop(0.6, theme.woodLit);
    trunk.addColorStop(1, theme.woodDark);
    ctx.fillStyle = trunk;

    // 根元へ向かって広がる幹。
    ctx.beginPath();
    ctx.moveTo(cx - 26, 0);
    ctx.lineTo(cx + 26, 0);
    ctx.quadraticCurveTo(cx + 34, h * 0.55, cx + 62, h);
    ctx.lineTo(cx - 62, h);
    ctx.quadraticCurveTo(cx - 34, h * 0.55, cx - 26, 0);
    ctx.closePath();
    ctx.fill();

    // 樹皮の縦筋。
    ctx.strokeStyle = this.alpha('#000000', 0.22);
    ctx.lineWidth = 2;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 9, 0);
      ctx.quadraticCurveTo(cx + i * 12, h * 0.55, cx + i * 17, h);
      ctx.stroke();
    }

    // 太い枝を左右に伸ばす。
    ctx.strokeStyle = theme.wood;
    ctx.lineCap = 'round';
    const branches: [number, number, number][] = [
      [h * 0.30, -1, 150],
      [h * 0.46, 1, 175],
      [h * 0.62, -1, 120],
    ];
    for (const [y, dir, len] of branches) {
      ctx.lineWidth = 13;
      ctx.beginPath();
      ctx.moveTo(cx + dir * 24, y);
      ctx.quadraticCurveTo(cx + dir * (len * 0.6), y - 18, cx + dir * len, y - 46);
      ctx.stroke();
      ctx.strokeStyle = this.alpha(theme.woodDark, 0.5);
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = theme.wood;
    }
  }

  private drawCanopyLayer(
    rng: () => number,
    w: number,
    h: number,
    color: string,
    top: number,
    radius: number,
    count: number,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const x = rng() * (w + 120) - 60;
      const y = top + rng() * h * 0.55;
      const r = radius * (0.5 + rng() * 0.8);
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.72, (rng() - 0.5) * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawCanopyBand(rng: () => number, w: number, theme: Theme): void {
    const ctx = this.ctx;
    ctx.fillStyle = theme.moss;
    for (let x = -30; x < w + 30; x += 26) {
      const r = 26 + rng() * 22;
      ctx.beginPath();
      ctx.ellipse(x, 6 + rng() * 14, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = this.alpha(theme.mossLit, 0.55);
    for (let x = -20; x < w + 20; x += 34) {
      const r = 16 + rng() * 14;
      ctx.beginPath();
      ctx.ellipse(x, 2 + rng() * 10, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // -------------------------------------------------------------------------
  // 地形とプロップ
  // -------------------------------------------------------------------------

  private drawTerrain(t: TerrainDef, theme: Theme): void {
    const ctx = this.ctx;
    const hw = t.hw ?? 10;
    const hh = t.hh ?? 10;

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle ?? 0);

    const path = new Path2D();
    if (t.verts && t.verts.length >= 3) {
      path.moveTo(t.verts[0].x, t.verts[0].y);
      for (let i = 1; i < t.verts.length; i++) path.lineTo(t.verts[i].x, t.verts[i].y);
      path.closePath();
    } else {
      path.rect(-hw, -hh, hw * 2, hh * 2);
    }

    let base = theme.rock;
    let lit = theme.rockLit;
    let dark = theme.rockDark;
    if (t.material === 'wood') {
      base = theme.wood;
      lit = theme.woodLit;
      dark = theme.woodDark;
    } else if (t.material === 'ice') {
      base = theme.ice;
      lit = theme.iceLit;
      dark = theme.rockDark;
    } else if (t.material === 'foliage') {
      base = theme.moss;
      lit = theme.mossLit;
      dark = theme.near;
    }

    const g = ctx.createLinearGradient(0, -hh, 0, hh);
    g.addColorStop(0, lit);
    g.addColorStop(0.35, base);
    g.addColorStop(1, dark);
    ctx.fillStyle = g;
    ctx.fill(path);

    ctx.strokeStyle = this.alpha('#000000', 0.35);
    ctx.lineWidth = 2;
    ctx.stroke(path);

    ctx.restore();

    // 岩の上面に苔を生やす。地形の「上に立てる面」が一目で分かるようにする。
    if (t.material === 'rock' && !t.verts) {
      const rng = makeRng(hashSeed(`${t.x},${t.y}`));
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.angle ?? 0);
      ctx.fillStyle = theme.moss;
      ctx.beginPath();
      ctx.rect(-hw, -hh, hw * 2, 7);
      ctx.fill();
      ctx.fillStyle = theme.mossLit;
      for (let x = -hw + 4; x < hw; x += 11) {
        const r = 4 + rng() * 5;
        ctx.beginPath();
        ctx.ellipse(x, -hh + 2, r, r * 0.75, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawProp(p: PropDef, theme: Theme, clock: number): void {
    const ctx = this.ctx;
    switch (p.type) {
      case 'goal':
        this.drawCrown(p.x, p.y, clock);
        break;
      case 'campfire':
        this.drawFire(p.x, p.y, clock);
        break;
      case 'thorn': {
        const hw = p.hw ?? 10;
        const hh = p.hh ?? 8;
        ctx.fillStyle = '#cfd6e0';
        ctx.strokeStyle = '#5b6472';
        ctx.lineWidth = 1.5;
        for (let x = -hw; x < hw; x += 8) {
          ctx.beginPath();
          ctx.moveTo(p.x + x, p.y + hh);
          ctx.lineTo(p.x + x + 4, p.y - hh);
          ctx.lineTo(p.x + x + 8, p.y + hh);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        break;
      }
      case 'anchor':
        ctx.strokeStyle = theme.woodLit;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.stroke();
        break;
    }
  }

  private drawCrown(x: number, y: number, clock: number): void {
    const ctx = this.ctx;
    const bob = Math.sin(clock * 2.2) * 2.5;
    ctx.save();
    ctx.translate(x, y + bob);

    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 46);
    glow.addColorStop(0, 'rgba(255,214,102,0.45)');
    glow.addColorStop(1, 'rgba(255,214,102,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(-46, -46, 92, 92);

    ctx.beginPath();
    ctx.moveTo(-16, 10);
    ctx.lineTo(-19, -12);
    ctx.lineTo(-8, -1);
    ctx.lineTo(0, -16);
    ctx.lineTo(8, -1);
    ctx.lineTo(19, -12);
    ctx.lineTo(16, 10);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -16, 0, 10);
    g.addColorStop(0, '#fff0b0');
    g.addColorStop(0.5, '#ffcc44');
    g.addColorStop(1, '#a86f10');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#7a4f08';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#e8484a';
    ctx.beginPath();
    ctx.arc(0, 3, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawFire(x: number, y: number, clock: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    // 薪。
    ctx.strokeStyle = '#5a3a1c';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-13, 9);
    ctx.lineTo(13, 4);
    ctx.moveTo(-13, 4);
    ctx.lineTo(13, 9);
    ctx.stroke();

    const glow = ctx.createRadialGradient(0, -4, 0, 0, -4, 40);
    glow.addColorStop(0, 'rgba(255,150,40,0.5)');
    glow.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(-40, -44, 80, 80);

    for (let i = 0; i < 3; i++) {
      const p = clock * 3.5 + i * 2.1;
      const sway = Math.sin(p) * 3;
      const hgt = 16 + Math.sin(p * 1.7) * 5 + i * 3;
      ctx.beginPath();
      ctx.moveTo(-7 + i * 5, 4);
      ctx.quadraticCurveTo(-3 + i * 5 + sway, -hgt * 0.5, 0 + i * 4 + sway, -hgt);
      ctx.quadraticCurveTo(3 + i * 5 + sway, -hgt * 0.5, 5 + i * 5, 4);
      ctx.closePath();
      ctx.fillStyle = i === 0 ? '#ffe066' : i === 1 ? '#ff9a2e' : '#e8501c';
      ctx.globalAlpha = 0.85;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // アイテム
  // -------------------------------------------------------------------------

  private drawRopes(sim: Simulation, theme: Theme): void {
    const ctx = this.ctx;
    for (const rope of sim.ropes) {
      const pts = rope.nodes.filter((n) => n.alive);
      if (pts.length < 2) continue;

      // 燃えていない部分を通しで描く。
      ctx.strokeStyle = theme.woodLit;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].px, pts[0].py);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
      ctx.stroke();

      ctx.strokeStyle = this.alpha('#000000', 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();

      // 燃焼中の火先。
      for (let i = 0; i < rope.nodes.length; i++) {
        if (!rope.burning[i] || !rope.nodes[i].alive) continue;
        const n = rope.nodes[i];
        const r = 4 + rope.burn[i] * 4;
        const g = ctx.createRadialGradient(n.px, n.py, 0, n.px, n.py, r * 2.6);
        g.addColorStop(0, 'rgba(255,220,120,0.95)');
        g.addColorStop(0.5, 'rgba(255,130,40,0.6)');
        g.addColorStop(1, 'rgba(255,90,20,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.px, n.py, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawBodies(sim: Simulation, theme: Theme, state: RenderState): void {
    for (const body of sim.world.bodies) {
      if (!body.alive) continue;
      const tag = body.tag as ItemId;
      if (!(tag in ITEMS)) continue;
      if (tag === 'rope') continue;
      const owner = body.owner as { id?: string } | null;
      const selected = state.selectedId !== null && owner?.id === state.selectedId;
      this.drawItemBody(tag, body.px, body.py, body.angle, theme, 1, selected, body);
    }
  }

  /** パレットのアイコンにも同じ関数を使い、置く前と後で見た目を一致させる。 */
  drawItemBody(
    item: ItemId,
    x: number,
    y: number,
    angle: number,
    theme: Theme,
    alpha: number,
    selected: boolean,
    body?: Body,
  ): void {
    const ctx = this.ctx;
    const spec = ITEMS[item];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);

    switch (item) {
      case 'platform': {
        const hw = spec.hw;
        const hh = spec.hh;
        const g = ctx.createLinearGradient(0, -hh, 0, hh);
        g.addColorStop(0, theme.woodLit);
        g.addColorStop(1, theme.woodDark);
        ctx.fillStyle = g;
        this.roundRect(-hw, -hh, hw * 2, hh * 2, 3);
        ctx.fill();
        // 板を束ねた見た目。原作の吊り足場に寄せる。
        ctx.strokeStyle = this.alpha('#000000', 0.35);
        ctx.lineWidth = 1;
        for (let sx = -hw + 6; sx < hw; sx += 8) {
          ctx.beginPath();
          ctx.moveTo(sx, -hh + 1);
          ctx.lineTo(sx, hh - 1);
          ctx.stroke();
        }
        ctx.strokeStyle = theme.woodDark;
        ctx.lineWidth = 1.5;
        this.roundRect(-hw, -hh, hw * 2, hh * 2, 3);
        ctx.stroke();
        break;
      }
      case 'balloon': {
        const r = spec.radius;
        const g = ctx.createRadialGradient(-r * 0.35, -r * 0.45, r * 0.15, 0, 0, r * 1.15);
        g.addColorStop(0, '#fff6b0');
        g.addColorStop(0.55, '#ffd23f');
        g.addColorStop(1, '#c08a10');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(0, -1, r * 0.92, r * 1.1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = this.alpha('#6b4a08', 0.7);
        ctx.lineWidth = 1.2;
        ctx.stroke();
        // 結び目。
        ctx.fillStyle = '#8a6410';
        ctx.beginPath();
        ctx.moveTo(-3, r * 1.02);
        ctx.lineTo(3, r * 1.02);
        ctx.lineTo(0, r * 1.02 + 5);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'bomb': {
        const r = spec.radius;
        const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.2);
        g.addColorStop(0, '#6a6a78');
        g.addColorStop(1, '#1c1c24');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#0c0c12';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // 導火線。
        ctx.strokeStyle = '#c8a45a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.quadraticCurveTo(6, -r - 7, 1, -r - 12);
        ctx.stroke();
        const owner = body?.owner as { ignited?: boolean } | null;
        if (owner?.ignited) {
          ctx.fillStyle = '#ffe066';
          ctx.beginPath();
          ctx.arc(1, -r - 13, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'spring': {
        const hw = spec.hw;
        const hh = spec.hh;
        ctx.strokeStyle = '#b9c2d0';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          ctx.lineTo(-hw + hw * 2 * t, (i % 2 === 0 ? -hh : hh) * 0.7);
        }
        ctx.stroke();
        ctx.fillStyle = '#8792a3';
        ctx.fillRect(-hw, hh - 3, hw * 2, 3);
        ctx.fillRect(-hw, -hh, hw * 2, 3);
        break;
      }
      case 'weight': {
        const hw = spec.hw;
        const hh = spec.hh;
        const g = ctx.createLinearGradient(0, -hh, 0, hh);
        g.addColorStop(0, '#5c6472');
        g.addColorStop(1, '#23272f');
        ctx.fillStyle = g;
        this.roundRect(-hw, -hh, hw * 2, hh * 2, 3);
        ctx.fill();
        ctx.strokeStyle = '#151a20';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#c9d2de';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('t', 0, 1);
        break;
      }
      case 'pulley': {
        const r = spec.radius;
        ctx.fillStyle = '#8792a3';
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#3c434f';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#3c434f';
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'rope': {
        ctx.strokeStyle = theme.woodLit;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-14, -10);
        ctx.quadraticCurveTo(2, 4, -6, 14);
        ctx.stroke();
        break;
      }
    }

    if (selected) {
      const r = spec.shape === 'circle' ? spec.radius + 6 : Math.max(spec.hw, spec.hh) + 8;
      ctx.strokeStyle = '#ffcc44';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 動物
  // -------------------------------------------------------------------------

  private drawWalkers(sim: Simulation, clock: number): void {
    for (const w of sim.walkers) {
      if (w.state === 'dead') continue;
      this.drawTiger(w, clock);
    }
  }

  private drawTiger(w: WalkerEntity, clock: number): void {
    const ctx = this.ctx;
    const b = w.body;
    if (this.drawWalkerRig(w, clock)) return;
    if (this.drawWalkerSprite(w, clock)) return;
    if (w.state === 'climb') {
      this.drawTigerClimbing(w, clock);
      return;
    }
    // 歩幅は移動距離に同期させる。止まれば脚も止まる。
    const phase = w.grounded ? b.px * 0.16 : clock * 5;
    const swing = Math.sin(phase) * (w.grounded ? 1 : 0.35);
    const bob = w.grounded ? Math.abs(Math.sin(phase)) * 1.2 : 0;

    ctx.save();
    // 足元を軸に一回り大きく描く。当たり判定は変えずに存在感だけ上げる。
    ctx.translate(b.px, b.py + 12);
    ctx.scale((w.dir >= 0 ? 1 : -1) * TIGER_SCALE, TIGER_SCALE);
    ctx.translate(0, -12 + bob);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // しっぽ。先をくるりと巻く。
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.moveTo(-5, 4);
    ctx.bezierCurveTo(-17, 6 + swing * 3, -20, -6, -12 + swing * 2, -10);
    ctx.stroke();
    ctx.strokeStyle = '#c2591f';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 脚。
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6.5;
    ctx.beginPath();
    ctx.moveTo(-1, 6);
    ctx.lineTo(-1 + swing * 5, 12);
    ctx.moveTo(3, 6);
    ctx.lineTo(3 - swing * 5, 12);
    ctx.stroke();
    ctx.strokeStyle = '#8c3f13';
    ctx.lineWidth = 4;
    ctx.stroke();

    // 胴。
    const g = ctx.createLinearGradient(0, -9, 0, 9);
    g.addColorStop(0, '#f08a34');
    g.addColorStop(1, '#a94d16');
    this.blob(() => ctx.ellipse(0, 1, 7.5, 8.5, 0, 0, Math.PI * 2), g);
    // 腹。
    this.blob(() => ctx.ellipse(1.5, 3, 4.5, 5, 0, 0, Math.PI * 2), '#f7c98f', 0);

    // 腕。振り子のように前後に振る。
    ctx.strokeStyle = INK;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(1, -2);
    ctx.lineTo(6 - swing * 5, 5);
    ctx.stroke();
    ctx.strokeStyle = '#c2591f';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    // 耳。頭より先に描いて後ろに回す。
    this.blob(() => ctx.arc(-2, -12, 3.4, 0, Math.PI * 2), '#c96426');
    this.blob(() => ctx.arc(7, -12, 3.4, 0, Math.PI * 2), '#c96426');

    // 頭。
    this.blob(() => ctx.arc(2.5, -10, 6.8, 0, Math.PI * 2), '#f08a34');
    // 顔まわり。
    this.blob(() => ctx.ellipse(5, -9, 4.6, 5, 0, 0, Math.PI * 2), '#f7c98f', 0);

    // 目。白目を入れると表情が出る。
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(5.6, -11, 2.2, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(6.3, -11, 1.3, 0, Math.PI * 2);
    ctx.fill();

    // 鼻と口。
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(6.4, -6.6, 1.8, Math.PI * 1.15, Math.PI * 1.9);
    ctx.stroke();

    ctx.restore();
  }

  /** 塗りつぶし＋濃い輪郭。手描き風の見た目をまとめて作る。 */
  private blob(path: () => void, fill: string | CanvasGradient, lineWidth = 1.6): void {
    const ctx = this.ctx;
    ctx.beginPath();
    path();
    ctx.fillStyle = fill;
    ctx.fill();
    if (lineWidth > 0) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  /**
   * 1 枚絵＋関節（リグ）で描く。歩行の位相は移動距離から求めるので、
   * 早送りでも一時停止でも脚の動きと実際の移動が一致する。
   */
  private drawWalkerRig(w: WalkerEntity, clock: number): boolean {
    const rig = this.rigs.get(w.type);
    if (!rig) return false;
    const b = w.body;
    const footY = b.py + 12;

    let clip = 'walk';
    let phase: number;
    if (w.state === 'climb') {
      clip = 'climb';
      phase = rig.phaseFromDistance(-b.py);
    } else if (w.state === 'fall') {
      clip = 'fall';
      phase = 0;
    } else {
      phase = rig.phaseFromDistance(b.px);
    }

    // 登りは正面向きなので反転しない。
    const flip = w.state === 'climb' ? false : w.dir < 0;
    rig.draw(this.ctx, clip, phase, b.px, footY, flip);
    void clock;
    return true;
  }

  /**
   * 画像が用意されていればそれで描く。
   * コマ送りは時計ではなくゲームの状態に同期させるので、早送りや一時停止でも
   * 絵と物理がずれない。歩きは移動距離、登りは高度で送る。
   */
  private drawWalkerSprite(w: WalkerEntity, clock: number): boolean {
    const sprite = this.sprites.get(w.type);
    if (!sprite) return false;
    const b = w.body;
    // 基準点は足元。当たり判定の半分の高さ(12)だけ下が接地面。
    const footY = b.py + 12;

    let clip = 'walk';
    let progress = b.px;
    if (w.state === 'climb') {
      clip = sprite.has('climb') ? 'climb' : 'walk';
      progress = -b.py;
    } else if (w.state === 'fall') {
      clip = sprite.has('fall') ? 'fall' : 'walk';
      progress = clock;
    } else if (Math.abs(b.vx) < 4 && sprite.has('idle')) {
      clip = 'idle';
      progress = clock;
    }
    if (!sprite.has(clip)) clip = Object.keys(sprite.def.clips)[0];

    // 登っている間はロープに正対させ、左右反転しない。
    const flip = w.state === 'climb' ? false : w.dir < 0;
    return sprite.draw(this.ctx, clip, progress, b.px, footY, flip);
  }

  /** ロープにしがみついた姿勢。手足を交互に出して登る。 */
  private drawTigerClimbing(w: WalkerEntity, clock: number): void {
    const ctx = this.ctx;
    const b = w.body;
    const swing = Math.sin(b.py * 0.22);

    ctx.save();
    ctx.translate(b.px, b.py);

    // しっぽはロープに巻きつける。
    ctx.strokeStyle = '#b3541e';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.quadraticCurveTo(10, 8, 7, -2);
    ctx.stroke();

    // 手足。左右交互に伸ばす。
    ctx.strokeStyle = '#8c3f13';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(-3, -4);
    ctx.lineTo(-7, -12 + swing * 4);
    ctx.moveTo(3, -4);
    ctx.lineTo(7, -12 - swing * 4);
    ctx.moveTo(-3, 5);
    ctx.lineTo(-7, 12 - swing * 3);
    ctx.moveTo(3, 5);
    ctx.lineTo(7, 12 + swing * 3);
    ctx.stroke();

    const g = ctx.createLinearGradient(0, -8, 0, 8);
    g.addColorStop(0, '#e0762c');
    g.addColorStop(1, '#a94d16');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 1, 6.5, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e0762c';
    ctx.beginPath();
    ctx.arc(0, -9, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f7c98f';
    ctx.beginPath();
    ctx.ellipse(0, -8, 4.2, 4.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#241206';
    ctx.beginPath();
    ctx.arc(-2, -9.5, 1.1, 0, Math.PI * 2);
    ctx.arc(2, -9.5, 1.1, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    void clock;
  }

  private drawBirds(sim: Simulation, clock: number): void {
    for (const bird of sim.birds) {
      if (bird.state === 'gone') continue;
      this.drawBird(bird, clock);
    }
  }

  private drawBird(bird: BirdEntity, clock: number): void {
    const ctx = this.ctx;
    const sprite = this.sprites.get('bird');
    if (sprite) {
      const clip = sprite.has(bird.state) ? bird.state : 'perched';
      if (sprite.draw(ctx, clip, clock, bird.x, bird.y + 6, bird.vx > 0)) return;
    }
    const flying = bird.state === 'flying';
    const flap = flying ? Math.sin(clock * 18) : Math.sin(clock * 2.4) * 0.12;
    const jitter = bird.state === 'startled' ? Math.sin(clock * 40) * 2 : 0;

    ctx.save();
    ctx.translate(bird.x + jitter, bird.y);
    if (flying && bird.vx > 0) ctx.scale(-1, 1);
    ctx.scale(BIRD_SCALE, BIRD_SCALE);
    ctx.lineJoin = 'round';

    // 長い尾。コンゴウインコらしさはここで出る。
    this.blob(() => {
      ctx.moveTo(-4, -1);
      ctx.quadraticCurveTo(-13, -2, -19, -7);
      ctx.quadraticCurveTo(-12, 2, -4, 3);
      ctx.closePath();
    }, '#e8434f');
    this.blob(() => {
      ctx.moveTo(-4, 0);
      ctx.quadraticCurveTo(-11, 2, -16, 1);
      ctx.quadraticCurveTo(-10, 4, -4, 4);
      ctx.closePath();
    }, '#f5c033');

    // 体。
    this.blob(() => ctx.ellipse(0, 0, 7.5, 6, 0, 0, Math.PI * 2), '#3fb0e8');

    // 翼。羽ばたきで角度が変わる。
    ctx.save();
    ctx.rotate(-flap * 0.75);
    this.blob(() => ctx.ellipse(-1, -3, 8.5, 3.8, 0.12, 0, Math.PI * 2), '#2f7fd6');
    this.blob(() => ctx.ellipse(-3, -3.5, 5, 2.4, 0.12, 0, Math.PI * 2), '#5ccf7a', 0);
    ctx.restore();

    // 頭。
    this.blob(() => ctx.arc(6, -4, 4.6, 0, Math.PI * 2), '#5ccf7a');
    // 頬の斑。
    this.blob(() => ctx.ellipse(8, -3.5, 2.4, 2.2, 0, 0, Math.PI * 2), '#fdf3e0', 0);

    // 湾曲したくちばし。
    this.blob(() => {
      ctx.moveTo(9, -6);
      ctx.quadraticCurveTo(15, -4.5, 12.5, 0.5);
      ctx.quadraticCurveTo(10.5, -1.5, 8.5, -1);
      ctx.closePath();
    }, '#ffb43f', 1.2);

    // 目。
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(7.4, -5.4, 1.3, 0, Math.PI * 2);
    ctx.fill();

    // 足。とまっているときだけ描く。
    if (!flying) {
      ctx.strokeStyle = '#c8863a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, 5.5);
      ctx.lineTo(0, 8);
      ctx.moveTo(3, 5.5);
      ctx.lineTo(3, 8);
      ctx.stroke();
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 演出と配置補助
  // -------------------------------------------------------------------------

  private updateEffects(dt: number): void {
    for (const e of this.effects) e.life -= dt;
    this.effects = this.effects.filter((e) => e.life > 0);
  }

  private drawEffects(): void {
    const ctx = this.ctx;
    for (const e of this.effects) {
      const t = 1 - e.life / e.max;
      if (e.kind === 'explosion') {
        const r = e.r * (0.35 + t * 0.9);
        const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
        g.addColorStop(0, `rgba(255,255,220,${0.9 * (1 - t)})`);
        g.addColorStop(0.35, `rgba(255,170,50,${0.75 * (1 - t)})`);
        g.addColorStop(0.7, `rgba(220,70,20,${0.45 * (1 - t)})`);
        g.addColorStop(1, 'rgba(120,30,10,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = `rgba(255,230,140,${1 - t})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const d = 6 + t * 18;
          ctx.beginPath();
          ctx.moveTo(e.x + Math.cos(a) * d * 0.5, e.y + Math.sin(a) * d * 0.5);
          ctx.lineTo(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d);
          ctx.stroke();
        }
      }
    }
  }

  private drawPlacementAids(state: RenderState, theme: Theme): void {
    const ctx = this.ctx;
    if (state.phase !== 'place') return;

    // ロープ接続中の候補点を光らせる。
    if (state.anchors.length > 0) {
      const pulse = 0.5 + Math.sin(state.clock * 5) * 0.25;
      for (const a of state.anchors) {
        ctx.strokeStyle = `rgba(255,204,68,${pulse})`;
        ctx.fillStyle = 'rgba(255,204,68,0.18)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 接続の 1 点目が決まっていれば、ポインタまで線を引く。
    if (state.ropeFrom && state.pointer) {
      ctx.strokeStyle = 'rgba(255,204,68,0.85)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(state.ropeFrom.x, state.ropeFrom.y);
      ctx.lineTo(state.pointer.x, state.pointer.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (state.ghost) {
      const g = state.ghost;
      this.drawItemBody(g.item, g.x, g.y, g.angle, theme, g.valid ? 0.62 : 0.28, false);
      if (!g.valid) {
        ctx.strokeStyle = 'rgba(232,103,74,0.9)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(g.x, g.y, 20, 0, Math.PI * 2);
        ctx.moveTo(g.x - 13, g.y - 13);
        ctx.lineTo(g.x + 13, g.y + 13);
        ctx.stroke();
      }
    }
  }

  // -------------------------------------------------------------------------

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  private alpha(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }
}

/** パレットのアイコン用に、単体のアイテムを小さなキャンバスへ描く。 */
export function drawItemIcon(canvas: HTMLCanvasElement, item: ItemId, biome: StageDef['biome']): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 46;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const r = new Renderer(canvas);
  const spec = ITEMS[item];
  const extent = spec.shape === 'circle' ? spec.radius : Math.max(spec.hw, spec.hh);
  const scale = Math.min(1, (size * 0.42) / extent);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(scale, scale);
  r.drawItemBody(item, 0, 0, 0, THEMES[biome], 1, false);
  ctx.restore();
}

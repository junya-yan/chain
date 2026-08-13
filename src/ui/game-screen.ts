/**
 * メインゲーム画面。
 *
 * 配置フェーズと実行フェーズを 1 つの Simulation で扱う。配置フェーズは
 * 「まだ 1 ステップも進めていない Simulation」を描いているだけなので、
 * 置いたものの見た目が実行前後でずれない。
 */

import {
  FIXED_DT,
  Simulation,
  anchorCandidates,
  type AnchorInfo,
  type SimStatus,
} from '../sim/simulation';
import { ITEMS } from '../sim/items';
import { canPlace } from '../sim/placement';
import type { ItemId, PlacementDef, StageDef } from '../sim/types';
import { Renderer, drawItemIcon, type Ghost, type RenderState } from '../render/renderer';
import type { SpriteSet } from '../render/sprites';
import type { RigSet } from '../render/rig';
import { getRecord, recordClear } from '../game/save';

type Phase = 'place' | 'run';

const SPEEDS = [1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

export interface GameScreenHandlers {
  onExit(): void;
  onNextStage(): void;
  hasNextStage(): boolean;
}

export class GameScreen {
  readonly el: HTMLElement;

  private stage: StageDef;
  private placements: PlacementDef[] = [];
  private sim: Simulation;
  private renderer: Renderer;
  private phase: Phase = 'place';
  private speed: Speed = 1;
  private paused = false;
  private accumulator = 0;
  private clock = 0;
  private lastFrame = 0;
  private raf = 0;
  private nextPlacementId = 0;

  /** パレットで選んでいるアイテム。 */
  private selectedItem: ItemId | null = null;
  /** 盤上で選んでいる配置済みアイテム。 */
  private selectedId: string | null = null;
  /** 2 点を繋ぐアイテムの、1 点目。 */
  private spanFrom: AnchorInfo | null = null;
  private dragging: { id: string; dx: number; dy: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private pointerInside = false;

  private view!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private paletteEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private resetBtn!: HTMLButtonElement;
  private hintBtn!: HTMLButtonElement;
  private editBar!: HTMLElement;
  private speedEl!: HTMLElement;
  private overlay: HTMLElement | null = null;
  private toastTimer = 0;
  private hintIndex = 0;

  constructor(stage: StageDef, private handlers: GameScreenHandlers) {
    this.stage = stage;
    this.el = document.createElement('div');
    this.el.className = 'game';
    this.buildDom();
    this.renderer = new Renderer(this.canvas);
    this.sim = new Simulation(this.stage, this.placements);
    this.refreshPalette();
    this.showBrief();
    this.attachEvents();
    this.start();
  }

  /** 用意されているキャラクター画像を渡す。空なら手続き的描画のまま。 */
  setArt(rigs: RigSet, sprites: SpriteSet): void {
    this.renderer.rigs = rigs;
    this.renderer.sprites = sprites;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  private buildDom(): void {
    this.el.innerHTML = `
      <div class="stage-view">
        <canvas></canvas>
        <div class="status-line"></div>
      </div>
      <div class="hud">
        <div class="hud-side">
          <button data-act="menu">MENU</button>
          <button data-act="hint">HINT</button>
        </div>
        <div class="palette"></div>
        <div class="hud-side edit-bar" hidden>
          <button data-act="rotate">回転</button>
          <button data-act="remove">撤去</button>
        </div>
        <div class="run-controls">
          <button class="primary" data-act="run">START</button>
          <button data-act="reset">リセット</button>
          <div class="speeds"></div>
        </div>
      </div>
    `;
    this.view = this.el.querySelector('.stage-view')!;
    this.canvas = this.el.querySelector('canvas')!;
    this.paletteEl = this.el.querySelector('.palette')!;
    this.statusEl = this.el.querySelector('.status-line')!;
    this.runBtn = this.el.querySelector('[data-act="run"]')!;
    this.resetBtn = this.el.querySelector('[data-act="reset"]')!;
    this.hintBtn = this.el.querySelector('[data-act="hint"]')!;
    this.editBar = this.el.querySelector('.edit-bar')!;
    this.speedEl = this.el.querySelector('.speeds')!;

    for (const s of SPEEDS) {
      const b = document.createElement('button');
      b.textContent = `${s}x`;
      b.dataset.speed = String(s);
      b.addEventListener('click', () => {
        this.speed = s;
        this.refreshSpeeds();
      });
      this.speedEl.append(b);
    }
    this.refreshSpeeds();

    if (!this.stage.hints || this.stage.hints.length === 0) this.hintBtn.disabled = true;

    this.el.querySelector('[data-act="menu"]')!.addEventListener('click', () => this.handlers.onExit());
    this.hintBtn.addEventListener('click', () => this.showHint());
    this.runBtn.addEventListener('click', () => this.toggleRun());
    this.resetBtn.addEventListener('click', () => this.resetToPlacement());
    this.el.querySelector('[data-act="rotate"]')!.addEventListener('click', () => this.rotateSelected());
    this.el.querySelector('[data-act="remove"]')!.addEventListener('click', () => this.removeSelected());
  }

  private refreshSpeeds(): void {
    for (const b of Array.from(this.speedEl.children) as HTMLButtonElement[]) {
      b.classList.toggle('on', b.dataset.speed === String(this.speed));
    }
  }

  private refreshPalette(): void {
    this.paletteEl.innerHTML = '';
    for (const entry of this.stage.inventory) {
      const used = this.placements.filter((p) => p.item === entry.item).length;
      const left = entry.count - used;

      const slot = document.createElement('button');
      slot.className = 'slot';
      slot.classList.toggle('selected', this.selectedItem === entry.item);
      slot.classList.toggle('empty', left <= 0);
      slot.disabled = this.phase === 'run';
      slot.title = `${ITEMS[entry.item].label} — ${ITEMS[entry.item].blurb}`;

      const icon = document.createElement('canvas');
      drawItemIcon(icon, entry.item, this.stage.biome);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(left);
      slot.append(icon, count);

      slot.addEventListener('click', () => {
        if (this.phase === 'run') return;
        this.selectedItem = this.selectedItem === entry.item ? null : entry.item;
        this.selectedId = null;
        this.spanFrom = null;
        this.refreshPalette();
        this.refreshEditBar();
        this.toast(
          this.selectedItem
            ? ITEMS[entry.item].spans
              ? 'つなぐ2点を順にクリック'
              : ITEMS[entry.item].blurb
            : '',
        );
      });
      this.paletteEl.append(slot);
    }
  }

  private refreshEditBar(): void {
    const show = this.phase === 'place' && this.selectedId !== null;
    this.editBar.hidden = !show;
    if (show) {
      const p = this.placements.find((x) => x.id === this.selectedId);
      const rotatable = p ? ITEMS[p.item].rotatable : false;
      (this.editBar.querySelector('[data-act="rotate"]') as HTMLButtonElement).disabled = !rotatable;
    }
  }

  // -------------------------------------------------------------------------
  // 入力
  // -------------------------------------------------------------------------

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', () => {
      this.pointerInside = false;
    });
    this.canvas.addEventListener('pointerenter', () => {
      this.pointerInside = true;
    });
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
  }

  private onResize = (): void => {
    this.renderer.resize(this.stage);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.overlay) {
      // クリア画面の「NEXT LEVEL? (Y)ES OR (N)OT」に応える。
      if (e.key === 'y' || e.key === 'Y') this.overlay.querySelector<HTMLButtonElement>('[data-yes]')?.click();
      if (e.key === 'n' || e.key === 'N') this.overlay.querySelector<HTMLButtonElement>('[data-no]')?.click();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      this.toggleRun();
    } else if (e.key === 'r' || e.key === 'R') {
      if (this.selectedId) this.rotateSelected();
      else this.resetToPlacement();
    } else if (e.key === 'Escape') {
      this.selectedItem = null;
      this.selectedId = null;
      this.spanFrom = null;
      this.refreshPalette();
      this.refreshEditBar();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      this.removeSelected();
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.phase === 'run' || this.overlay) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // 合成イベントなど、捕捉できないポインタでも配置自体は続行させる。
    }
    const p = this.renderer.toLogical(e.clientX, e.clientY);
    this.pointer = p;

    if (this.selectedItem && ITEMS[this.selectedItem].spans) {
      this.handleSpanClick(this.selectedItem, p);
      return;
    }
    if (this.selectedItem) {
      this.tryPlace(this.selectedItem, p.x, p.y);
      return;
    }
    // パレット未選択なら、置いてあるものを掴む。
    const hit = this.hitTest(p.x, p.y);
    if (hit) {
      this.selectedId = hit.id;
      this.dragging = { id: hit.id, dx: hit.x - p.x, dy: hit.y - p.y };
    } else {
      this.selectedId = null;
    }
    this.refreshEditBar();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.renderer.toLogical(e.clientX, e.clientY);
    this.pointer = p;
    this.pointerInside = true;
    if (!this.dragging || this.phase === 'run') return;
    const target = this.placements.find((x) => x.id === this.dragging!.id);
    if (!target) return;
    target.x = p.x + this.dragging.dx;
    target.y = p.y + this.dragging.dy;
    this.rebuild();
  };

  private onPointerUp = (e: PointerEvent): void => {
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* 捕捉していないポインタなら何もしなくてよい */
    }
    if (!this.dragging) return;
    const target = this.placements.find((x) => x.id === this.dragging!.id);
    this.dragging = null;
    if (!target) return;
    // 画面外へドラッグしたら撤去する。
    const { w, h } = this.stage.world.bounds;
    if (target.x < 0 || target.x > w || target.y < 0 || target.y > h) {
      this.removePlacement(target.id);
    } else if (!this.isValid(target.item, target.x, target.y, target.angle ?? 0, target.id)) {
      this.removePlacement(target.id);
      this.toast('そこには置けない');
    }
  };

  /** ロープ・吊り橋のように、2 点を選んで架けるアイテムの置き方。 */
  private handleSpanClick(item: ItemId, p: { x: number; y: number }): void {
    const anchors = anchorCandidates(this.stage, this.placements);
    const near = nearest(anchors, p.x, p.y, 34);
    if (!near) {
      this.toast('つなげる点がない');
      return;
    }
    if (!this.spanFrom) {
      this.spanFrom = near;
      this.toast('もう1点を選ぶ');
      return;
    }
    if (near.id === this.spanFrom.id) {
      this.spanFrom = null;
      return;
    }
    if (this.remaining(item) <= 0) {
      this.toast(`${ITEMS[item].label}が足りない`);
      this.spanFrom = null;
      return;
    }
    this.placements.push({
      id: this.newId(),
      item,
      x: 0,
      y: 0,
      from: { target: this.spanFrom.id },
      to: { target: near.id },
    });
    this.spanFrom = null;
    if (this.remaining(item) <= 0) this.selectedItem = null;
    this.rebuild();
    this.refreshPalette();
  }

  private tryPlace(item: ItemId, x: number, y: number): void {
    if (this.remaining(item) <= 0) {
      this.toast(`${ITEMS[item].label}はもうない`);
      return;
    }
    if (!this.isValid(item, x, y, 0, null)) {
      this.toast('そこには置けない');
      return;
    }
    const id = this.newId();
    this.placements.push({ id, item, x, y, angle: 0 });
    this.selectedId = id;
    if (this.remaining(item) <= 0) this.selectedItem = null;
    this.rebuild();
    this.refreshPalette();
    this.refreshEditBar();
  }

  private hitTest(x: number, y: number): { id: string; x: number; y: number } | null {
    // 後に置いたものを優先して掴む。
    for (let i = this.placements.length - 1; i >= 0; i--) {
      const p = this.placements[i];
      if (ITEMS[p.item].spans) continue;
      const spec = ITEMS[p.item];
      const r = spec.shape === 'circle' ? spec.radius + 4 : Math.max(spec.hw, spec.hh) + 4;
      if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) return { id: p.id, x: p.x, y: p.y };
    }
    return null;
  }

  /** 地形や画面外と重なっていないか。判定は sim 層と共有する。 */
  private isValid(item: ItemId, x: number, y: number, angle: number, ignoreId: string | null): boolean {
    return canPlace(this.stage, this.placements, item, x, y, angle, ignoreId);
  }

  private rotateSelected(): void {
    const p = this.placements.find((x) => x.id === this.selectedId);
    if (!p || !ITEMS[p.item].rotatable) return;
    p.angle = ((p.angle ?? 0) + Math.PI / 12) % (Math.PI * 2);
    this.rebuild();
  }

  private removeSelected(): void {
    if (this.phase !== 'place' || !this.selectedId) return;
    this.removePlacement(this.selectedId);
  }

  private removePlacement(id: string): void {
    // このアイテムに繋がっていたロープも一緒に外す。
    this.placements = this.placements.filter(
      (p) => p.id !== id && p.from?.target !== id && p.to?.target !== id,
    );
    this.selectedId = null;
    this.rebuild();
    this.refreshPalette();
    this.refreshEditBar();
  }

  private remaining(item: ItemId): number {
    const entry = this.stage.inventory.find((e) => e.item === item);
    if (!entry) return 0;
    return entry.count - this.placements.filter((p) => p.item === item).length;
  }

  private newId(): string {
    return `p${this.nextPlacementId++}`;
  }

  /** 配置が変わったら Simulation を組み直す（＝初期状態を作り直す）。 */
  private rebuild(): void {
    this.sim = new Simulation(this.stage, this.placements);
  }

  // -------------------------------------------------------------------------
  // 実行
  // -------------------------------------------------------------------------

  private toggleRun(): void {
    if (this.overlay) return;
    if (this.phase === 'place') {
      if (this.placements.length === 0) {
        this.toast('まず何か置いてみよう');
        return;
      }
      this.phase = 'run';
      this.paused = false;
      this.accumulator = 0;
      this.selectedItem = null;
      this.selectedId = null;
      this.spanFrom = null;
      this.rebuild();
      this.runBtn.textContent = '一時停止';
      this.refreshPalette();
      this.refreshEditBar();
    } else {
      this.paused = !this.paused;
      this.runBtn.textContent = this.paused ? '再開' : '一時停止';
    }
  }

  private resetToPlacement(): void {
    this.phase = 'place';
    this.paused = false;
    this.accumulator = 0;
    this.runBtn.textContent = 'START';
    this.rebuild();
    this.refreshPalette();
    this.refreshEditBar();
  }

  private start(): void {
    this.renderer.resize(this.stage);
    this.lastFrame = performance.now();
    const loop = (now: number): void => {
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.clock += dt;
      this.tick(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(dt: number): void {
    this.renderer.resize(this.stage);

    if (this.phase === 'run' && !this.paused && this.sim.getStatus() === 'running') {
      // 固定タイムステップ。実フレームレートに依存しない。
      this.accumulator += dt;
      let guard = 0;
      while (this.accumulator >= FIXED_DT && guard < 16) {
        this.accumulator -= FIXED_DT;
        guard++;
        for (let i = 0; i < this.speed && this.sim.getStatus() === 'running'; i++) this.sim.step();
      }
      this.consumeEvents();
      const status: SimStatus = this.sim.getStatus();
      if (status === 'won') this.onWin();
      else if (status === 'lost') this.onLose();
    }

    const state: RenderState = {
      phase: this.phase,
      ghost: this.buildGhost(),
      anchors:
        this.phase === 'place' && this.selectedItem && ITEMS[this.selectedItem].spans
          ? anchorCandidates(this.stage, this.placements)
          : [],
      spanFrom: this.spanFrom,
      pointer: this.pointer,
      selectedId: this.selectedId,
      clock: this.clock,
    };
    this.renderer.draw(this.sim, state, dt);
    this.updateStatus();

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.querySelector('.toast')?.remove();
    }
  }

  private buildGhost(): Ghost | null {
    if (this.phase !== 'place' || !this.selectedItem || !this.pointer || !this.pointerInside) return null;
    if (ITEMS[this.selectedItem].spans) return null;
    return {
      item: this.selectedItem,
      x: this.pointer.x,
      y: this.pointer.y,
      angle: 0,
      valid: this.isValid(this.selectedItem, this.pointer.x, this.pointer.y, 0, null),
    };
  }

  private consumeEvents(): void {
    for (const ev of this.sim.drainEvents()) {
      if (ev.type === 'explosion') this.renderer.addEffect('explosion', ev.x, ev.y, ev.r ?? 90);
      else if (ev.type === 'pop') this.renderer.addEffect('pop', ev.x, ev.y, 14);
      else if (ev.type === 'ignite') this.renderer.addEffect('spark', ev.x, ev.y, 8);
    }
  }

  private updateStatus(): void {
    const used = this.placements.length;
    const record = getRecord(this.stage.id);
    const parts = [
      `<span class="k">使用</span> ${used} / <span class="k">目標</span> ${this.stage.par}`,
    ];
    if (this.phase === 'run') parts.push(`<span class="k">経過</span> ${this.sim.time.toFixed(1)}s`);
    if (record?.cleared) parts.push(`<span class="k">最少</span> ${record.bestItems}`);
    this.statusEl.innerHTML = parts.join('');
  }

  // -------------------------------------------------------------------------
  // 結果
  // -------------------------------------------------------------------------

  private onWin(): void {
    recordClear(this.stage.id, this.placements.length);
    this.refreshPalette();
    const hasNext = this.handlers.hasNextStage();
    this.showOverlay(`
      <h2>CONGRATULATIONS</h2>
      <p>${this.stage.name} クリア。使用アイテム ${this.placements.length} 個（目標 ${this.stage.par}）</p>
      <p>NEXT LEVEL? (Y)ES OR (N)OT</p>
      <div class="row">
        <button class="primary" data-yes ${hasNext ? '' : 'disabled'}>YES</button>
        <button data-no>NOT</button>
      </div>
    `);
    this.overlay!.querySelector('[data-yes]')!.addEventListener('click', () => {
      this.closeOverlay();
      this.handlers.onNextStage();
    });
    this.overlay!.querySelector('[data-no]')!.addEventListener('click', () => {
      this.closeOverlay();
      this.handlers.onExit();
    });
  }

  private onLose(): void {
    // 失敗コストはゼロにする。ダイアログを挟まず、配置をそのままに戻す。
    this.toast(this.sim.failReason || '失敗', 2.4);
    this.resetToPlacement();
  }

  private showBrief(): void {
    this.showOverlay(`
      <h2>${this.stage.name}</h2>
      <p>${this.stage.brief}</p>
      <div class="row"><button class="primary" data-yes>はじめる</button></div>
    `);
    this.overlay!.querySelector('[data-yes]')!.addEventListener('click', () => this.closeOverlay());
  }

  private showHint(): void {
    const hints = this.stage.hints ?? [];
    if (hints.length === 0) return;
    const hint = hints[Math.min(this.hintIndex, hints.length - 1)];
    this.hintIndex++;
    this.toast(hint, 5);
  }

  private showOverlay(html: string): void {
    this.closeOverlay();
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = html;
    this.view.append(el);
    this.overlay = el;
  }

  private closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private toast(msg: string, seconds = 2): void {
    this.el.querySelector('.toast')?.remove();
    if (!msg) {
      this.toastTimer = 0;
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    this.view.append(el);
    this.toastTimer = seconds;
  }
}

function nearest(list: AnchorInfo[], x: number, y: number, maxDist: number): AnchorInfo | null {
  let best: AnchorInfo | null = null;
  let bestD = maxDist;
  for (const a of list) {
    const d = Math.sqrt((a.x - x) ** 2 + (a.y - y) ** 2);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/**
 * ゲームルール層。
 *
 * ステージ定義とプレイヤーの配置から world を組み立て、固定ステップで進め、
 * ミッションの達成を判定する。DOM に一切依存しないので、ブラウザでも Node でも
 * 同じ結果になる（tools/verify-stages.ts がこれを利用してステージの
 * クリア可能性を自動検証している）。
 */

import {
  CAT_ACTOR,
  CAT_ALL,
  CAT_DECK,
  CAT_DYNAMIC,
  CAT_ROPE,
  CAT_STATIC,
  World,
  createBox,
  createCircle,
  createPoly,
  resetBodyIds,
  toLocal,
  toWorld,
  type Body,
  type Link,
} from './physics';
import { ITEMS } from './items';
import { distance, length, type Vec } from './vec';
import type { AnchorRef, PlacementDef, PropDef, StageDef } from './types';

/** 固定タイムステップ。可変フレームレートに依存しない。 */
export const FIXED_DT = 1 / 60;

const WALK_SPEED = 62;
const ROPE_NODE_SPACING = 12;
/**
 * 吊り橋のたるみ。架け渡す 2 点間距離に対する、踏み板の総延長の余り。
 * 踏み板は伸びないので、この余りだけが「垂れしろ」になる。0 だと張った棒に
 * なってしまい、吊り橋にならない。
 *
 * 実測では、たわみの深さはおおよそ「架けた距離 x 0.18」になる。深さは
 * 架けた距離だけで決まり、何が乗っても大きくは変わらない（板が伸びないため）。
 */
const BRIDGE_SLACK = 0.06;
const BOMB_FUSE = 0.9;
const BLAST_RADIUS = 96;
const BLAST_POWER = 620;
const BURN_RATE = 6.5; // ロープを 1 秒あたり何ノード燃え進むか
/**
 * 燃焼中のノードが持つ火源の半径。
 * ROPE_NODE_SPACING より必ず大きくすること。小さいと隣のノードに火が届かず、
 * 着火しても燃え広がらない。
 */
const BURN_SPREAD_RADIUS = ROPE_NODE_SPACING + 6;
const FIRE_RADIUS = 16;
const STARTLE_RADIUS = 150;
/** これ以下の段差は登れる。板が地形に乗ったときの段差を越えるために必要。 */
const STEP_HEIGHT = 13;
const CLIMB_SPEED = 52;
/** ロープを掴める距離。歩いてきて自然に掴めるよう、横に広めに取る。 */
const CLIMB_GRAB_MARGIN = 20;
/** 掴み続けられる距離。掴んだ後に外れにくくする。 */
const CLIMB_HOLD_MARGIN = 26;
/** ロープ上端から飛び移るときの初速。 */
const CLIMB_HOP_VX = 95;
const CLIMB_HOP_VY = 70;
/** 動物の頭の高さ。ロープの上端に「頭が届いた」判定に使う。 */
const CLIMB_HEAD = 12;
/** これだけ登れない時間が続いたら手を離す。 */
const CLIMB_STALL_LIMIT = 0.2;

export type SimStatus = 'running' | 'won' | 'lost';

export interface SimEvent {
  type: 'explosion' | 'pop' | 'ignite' | 'land' | 'goal' | 'die' | 'flyaway';
  x: number;
  y: number;
  /** explosion のみ。爆風半径。 */
  r?: number;
}

export interface RopeEntity {
  kind: 'rope';
  id: string;
  nodes: Body[];
  /** ノード間のリンク。nodes.length - 1 本。 */
  segments: Link[];
  /** 両端をボディに固定するリンク。 */
  pins: Link[];
  /**
   * 両端のボディを直接結ぶ最大距離拘束。ノード列だけでは多段拘束が伸びて
   * しまうため、これで「ロープの長さ以上には離れない」ことを保証する。
   */
  spine: Link | null;
  /** ノードごとの燃焼進捗 0..1。 */
  burn: number[];
  burning: boolean[];
  severed: boolean;
}

export interface BridgeEntity {
  kind: 'bridge';
  id: string;
  /** 端から順に並んだ踏み板。 */
  planks: Body[];
  /** 踏み板どうしと両端を留める蝶番。 */
  hinges: Link[];
}

export interface BalloonEntity {
  kind: 'balloon';
  id: string;
  body: Body;
  popped: boolean;
}

export interface BombEntity {
  kind: 'bomb';
  id: string;
  body: Body;
  ignited: boolean;
  fuse: number;
  exploded: boolean;
}

export interface PropEntity {
  kind: 'prop';
  id: string;
  def: PropDef;
  body: Body | null;
}

export type WalkerState = 'walk' | 'fall' | 'climb' | 'won' | 'dead';

export interface WalkerEntity {
  kind: 'walker';
  id: string;
  type: string;
  body: Body;
  dir: number;
  state: WalkerState;
  /** 表示用。接地しているか。 */
  grounded: boolean;
  /** 反転直後の連打を防ぐためのクールダウン。 */
  turnCooldown: number;
  /** 手を離した直後に同じロープを掴み直さないためのクールダウン。 */
  climbCooldown: number;
  /** 登っているのに高度が上がらない状態が続いた時間。 */
  climbStall: number;
  climbLastY: number;
}

export type BirdState = 'perched' | 'startled' | 'flying' | 'gone';

export interface BirdEntity {
  kind: 'bird';
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BirdState;
  timer: number;
  variant: string;
}

/** 描画とロープ接続 UI が使う「掴める点」。 */
export interface AnchorInfo {
  id: string;
  x: number;
  y: number;
  /** ロープを繋げられるか。 */
  attachable: boolean;
}

export interface SimBuildResult {
  ok: boolean;
  errors: string[];
}

export class Simulation {
  readonly stage: StageDef;
  readonly world: World;
  time = 0;
  status: SimStatus = 'running';
  /** 失敗理由。UI の表示に使う。 */
  failReason = '';
  events: SimEvent[] = [];

  ropes: RopeEntity[] = [];
  bridges: BridgeEntity[] = [];
  balloons: BalloonEntity[] = [];
  bombs: BombEntity[] = [];
  walkers: WalkerEntity[] = [];
  birds: BirdEntity[] = [];
  props: PropEntity[] = [];
  /** 配置アイテムの id → ボディ。ロープの接続先解決に使う。 */
  private placed = new Map<string, Body>();
  /** 一時的な火源（爆風・燃焼中のロープ）。毎ステップ作り直す。 */
  private fires: { x: number; y: number; r: number }[] = [];
  private stillTime = 0;

  constructor(stage: StageDef, placements: PlacementDef[]) {
    this.stage = stage;
    resetBodyIds();
    this.world = new World({
      gravity: stage.world.gravity,
      wind: stage.world.wind ?? 0,
      velocityIterations: 10,
    });
    this.buildTerrain();
    this.buildProps();
    this.buildActors();
    this.buildPlacements(placements);
  }

  // -------------------------------------------------------------------------
  // 構築
  // -------------------------------------------------------------------------

  private buildTerrain(): void {
    const { w, h } = this.stage.world.bounds;
    // 画面の左右と上を壁で閉じる。下は開けておき、落ちたら失敗にする。
    // 風船が「天井まで浮上して止まる」ことで足場の高さが決まる、という
    // このゲームの根幹の挙動は、この上壁が支えている。
    const wall = 40;
    this.world.add(createBox({ x: -wall, y: h / 2, hw: wall, hh: h * 2, isStatic: true, tag: 'wall' }));
    this.world.add(createBox({ x: w + wall, y: h / 2, hw: wall, hh: h * 2, isStatic: true, tag: 'wall' }));
    this.world.add(createBox({ x: w / 2, y: -wall, hw: w * 2, hh: wall, isStatic: true, tag: 'ceiling' }));

    for (const t of this.stage.terrain) {
      const common = {
        x: t.x,
        y: t.y,
        angle: t.angle ?? 0,
        isStatic: true,
        friction: t.friction ?? 0.9,
        tag: `terrain:${t.material}`,
      };
      if (t.verts && t.verts.length >= 3) {
        this.world.add(createPoly({ ...common, verts: t.verts }));
      } else {
        this.world.add(createBox({ ...common, hw: t.hw ?? 10, hh: t.hh ?? 10 }));
      }
    }
  }

  private buildProps(): void {
    for (const [i, def] of (this.stage.props ?? []).entries()) {
      const id = def.id ?? `${def.type}${i}`;
      let body: Body | null = null;
      if (def.type === 'anchor' || def.type === 'campfire') {
        // ロープの接続先になる不動点。物理的な衝突はさせない。
        body = createCircle({
          x: def.x,
          y: def.y,
          radius: 4,
          isStatic: true,
          sensor: true,
          tag: def.type,
        });
        this.world.add(body);
      } else if (def.type === 'thorn') {
        body = createBox({
          x: def.x,
          y: def.y,
          hw: def.hw ?? 10,
          hh: def.hh ?? 8,
          isStatic: true,
          tag: 'thorn',
        });
        this.world.add(body);
      }
      this.props.push({ kind: 'prop', id, def, body });
    }
  }

  private buildActors(): void {
    for (const [i, a] of this.stage.actors.entries()) {
      if (a.type === 'bird') {
        this.birds.push({
          kind: 'bird',
          id: `bird${i}`,
          x: a.x,
          y: a.y,
          vx: 0,
          vy: 0,
          state: 'perched',
          timer: 0,
          variant: a.variant ?? 'macaw',
        });
        continue;
      }
      // 歩く動物。転倒されると理不尽なので回転は殺す。
      const body = createBox({
        x: a.x,
        y: a.y,
        hw: 8,
        hh: 12,
        mass: 1.1,
        friction: 0.9,
        restitution: 0,
        fixedRotation: true,
        linearDamping: 0.02,
        category: CAT_ACTOR,
        mask: CAT_STATIC | CAT_DYNAMIC | CAT_ACTOR | CAT_DECK,
        tag: a.type,
      });
      this.world.add(body);
      const walker: WalkerEntity = {
        kind: 'walker',
        id: `${a.type}${i}`,
        type: a.type,
        body,
        dir: a.dir ?? -1,
        state: 'walk',
        grounded: false,
        turnCooldown: 0,
        climbCooldown: 0,
        climbStall: 0,
        climbLastY: a.y,
      };
      body.owner = walker;
      this.walkers.push(walker);
    }
  }

  private buildPlacements(placements: PlacementDef[]): void {
    // 2 点を繋ぐ物は接続先が先に存在している必要があるので、2 パスに分ける。
    for (const p of placements) {
      if (ITEMS[p.item].spans) continue;
      const spec = ITEMS[p.item];
      const common = {
        x: p.x,
        y: p.y,
        angle: p.angle ?? 0,
        mass: spec.mass,
        restitution: spec.restitution,
        friction: spec.friction,
        isStatic: spec.isStatic,
        linearDamping: spec.linearDamping,
        angularDamping: spec.angularDamping,
        buoyancy: spec.buoyancyScale * this.world.gravity,
        tag: p.item,
      };
      const body =
        spec.shape === 'circle'
          ? createCircle({ ...common, radius: spec.radius })
          : createBox({ ...common, hw: spec.hw, hh: spec.hh });
      this.world.add(body);
      this.placed.set(p.id, body);
      // 描画と選択のために、どのボディがどの配置由来かを常に辿れるようにする。
      body.owner = { kind: 'item', id: p.id };

      if (p.item === 'balloon') {
        const ent: BalloonEntity = { kind: 'balloon', id: p.id, body, popped: false };
        body.owner = ent;
        this.balloons.push(ent);
      } else if (p.item === 'bomb') {
        const ent: BombEntity = {
          kind: 'bomb',
          id: p.id,
          body,
          ignited: false,
          fuse: BOMB_FUSE,
          exploded: false,
        };
        body.owner = ent;
        this.bombs.push(ent);
      }
    }

    // 吊り橋はロープの接続先になれるので、ロープより先に架ける。
    for (const p of placements) {
      if (p.item !== 'bridge' || !p.from || !p.to) continue;
      const a = this.resolveAnchor(p.from);
      const b = this.resolveAnchor(p.to);
      if (!a || !b) continue;
      this.createBridge(p.id, a, b);
    }

    for (const p of placements) {
      if (p.item !== 'rope' || !p.from || !p.to) continue;
      const a = this.resolveAnchor(p.from);
      const b = this.resolveAnchor(p.to);
      if (!a || !b) continue;
      this.createRope(p.id, a, b);
    }
  }

  private resolveAnchor(ref: AnchorRef): Body | null {
    const placed = this.placed.get(ref.target);
    if (placed) return placed;
    const prop = this.props.find((p) => p.id === ref.target);
    return prop?.body ?? null;
  }

  /**
   * 2 つのボディの間に吊り橋を架ける。
   *
   * 踏み板を蝶番で数珠つなぎにし、両端を留める。板は伸びないので、
   * 総延長と 2 点間距離の差（BRIDGE_SLACK）だけが垂れしろになる。つまり
   * 「どれだけ垂れるか」は架け渡した距離だけで決まり、毎回同じになる。
   *
   * 初期姿勢は、垂れた後とほぼ同じ放物線に並べておく。まっすぐ並べると
   * 開始直後に大きく落ち込み、配置画面と実行直後で見た目が変わってしまう。
   */
  private createBridge(id: string, a: Body, b: Body): BridgeEntity {
    const pa = surfacePoint(a, b.px, b.py);
    const pb = surfacePoint(b, a.px, a.py);
    const span = distance(pa.x, pa.y, pb.x, pb.y);
    const deck = span * (1 + BRIDGE_SLACK);
    const spec = ITEMS.bridge;
    // 踏み板の枚数は総延長から決める。1 枚の幅は仕様値のおおよそに収まる。
    const count = Math.max(2, Math.round(deck / (spec.hw * 2)));
    const hw = deck / count / 2;
    // 弛んだ紐が描く放物線の垂れ量。弧長が総延長に一致するようにとった近似。
    const sag = Math.sqrt((3 * span * (deck - span)) / 8);

    const at = (t: number): Vec => ({
      x: pa.x + (pb.x - pa.x) * t,
      y: pa.y + (pb.y - pa.y) * t + 4 * sag * t * (1 - t),
    });

    const planks: Body[] = [];
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const c = at(t);
      // 接線に沿わせる。板どうしが折れ曲がった状態から始めない。
      const angle = Math.atan2(pb.y - pa.y + 4 * sag * (1 - 2 * t), pb.x - pa.x);
      const plank = createBox({
        x: c.x,
        y: c.y,
        angle,
        hw,
        hh: spec.hh,
        mass: spec.mass / count,
        friction: spec.friction,
        restitution: 0,
        linearDamping: spec.linearDamping,
        angularDamping: spec.angularDamping,
        category: CAT_DECK,
        // 隣の板とは蝶番で繋がっているので、板どうしは当てない。当てると
        // 常時めり込み扱いになって橋が震える。
        mask: CAT_STATIC | CAT_DYNAMIC | CAT_ACTOR,
        tag: 'plank',
      });
      this.world.add(plank);
      planks.push(plank);
    }

    // 蝶番。隣り合う板の端どうしを 1 点で留めるので、折れ曲がりはするが
    // 離れはしない。
    const hinges: Link[] = [];
    for (let i = 0; i < count - 1; i++) {
      const joint = toWorld(planks[i], hw, 0);
      hinges.push(
        this.world.connect(planks[i], planks[i + 1], {
          anchorA: joint,
          anchorB: joint,
          rest: 0,
          rigid: true,
        }),
      );
    }
    hinges.push(
      this.world.connect(a, planks[0], { anchorA: pa, anchorB: pa, rest: 0, rigid: true }),
      this.world.connect(b, planks[count - 1], { anchorA: pb, anchorB: pb, rest: 0, rigid: true }),
    );

    // 蝶番だけでは多段拘束が伸び、踏むたびに底なしに垂れてしまう。ロープの
    // spine と同じ考えで、板ごとに「両端から桁を辿った長さ以上には離れない」
    // 拘束を重ねる。これで垂れる深さが架けた距離だけで決まるようになる。
    for (let i = 0; i < count; i++) {
      this.world.connect(a, planks[i], { anchorA: pa, rest: hw * (2 * i + 1), rigid: false });
      this.world.connect(b, planks[i], {
        anchorA: pb,
        rest: hw * (2 * (count - 1 - i) + 1),
        rigid: false,
      });
    }

    const bridge: BridgeEntity = { kind: 'bridge', id, planks, hinges };
    for (const plank of planks) plank.owner = bridge;
    // 真ん中の板を橋の代表にする。ロープはここへ繋がる。
    this.placed.set(id, planks[count >> 1]);
    this.bridges.push(bridge);
    return bridge;
  }

  /**
   * 2 つのボディをロープで繋ぐ。
   * 接続点は「相手に最も近い自分の表面上の点」にする。板の端に繋げば端から
   * 吊られて傾く、という原作どおりの挙動がこれで自然に出る。
   */
  private createRope(id: string, a: Body, b: Body): RopeEntity {
    const pa = surfacePoint(a, b.px, b.py);
    const pb = surfacePoint(b, a.px, a.py);
    const total = distance(pa.x, pa.y, pb.x, pb.y);
    const count = Math.max(2, Math.round(total / ROPE_NODE_SPACING) + 1);
    const spec = ITEMS.rope;

    const nodes: Body[] = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const node = createCircle({
        x: pa.x + (pb.x - pa.x) * t,
        y: pa.y + (pb.y - pa.y) * t,
        radius: spec.radius,
        mass: spec.mass,
        friction: spec.friction,
        restitution: 0,
        linearDamping: 0.4,
        fixedRotation: true,
        category: CAT_ROPE,
        // ロープが何にでも絡むと挙動が読めなくなるので、地形と滑車だけに当てる。
        mask: CAT_STATIC,
        tag: 'rope',
      });
      this.world.add(node);
      nodes.push(node);
    }

    const segLen = total / (count - 1);
    const segments: Link[] = [];
    for (let i = 0; i < count - 1; i++) {
      segments.push(this.world.connect(nodes[i], nodes[i + 1], { rest: segLen, rigid: false }));
    }

    // 両端をボディへ固定する（rest 0 の剛体拘束＝ピン留め）。
    const pins: Link[] = [
      this.world.connect(a, nodes[0], { anchorA: pa, anchorB: pa, rest: 0, rigid: true }),
      this.world.connect(b, nodes[count - 1], { anchorA: pb, anchorB: pb, rest: 0, rigid: true }),
    ];

    // ノード列だけだと拘束が多段になって伸びるため、両端を直接結ぶ最大距離拘束を
    // 併せて張る。これで「ロープの長さ以上には絶対に離れない」ことが保証される。
    const spine = this.world.connect(a, b, {
      anchorA: pa,
      anchorB: pb,
      rest: total,
      rigid: false,
    });

    const rope: RopeEntity = {
      kind: 'rope',
      id,
      nodes,
      segments,
      pins,
      spine,
      burn: new Array(count).fill(0),
      burning: new Array(count).fill(false),
      severed: false,
    };
    for (const n of nodes) n.owner = rope;
    this.ropes.push(rope);
    return rope;
  }

  // -------------------------------------------------------------------------
  // 更新
  // -------------------------------------------------------------------------

  step(): void {
    if (this.status !== 'running') return;
    const dt = FIXED_DT;

    this.fires.length = 0;
    for (const p of this.props) {
      if (p.def.type === 'campfire') {
        this.fires.push({ x: p.def.x, y: p.def.y, r: FIRE_RADIUS });
      }
    }

    this.world.step(dt);
    this.time += dt;

    this.updateRopes(dt);
    this.updateBombs(dt);
    this.updateBalloons();
    this.updateWalkers(dt);
    this.updateBirds(dt);
    this.checkMission();
    this.checkStall(dt);
  }

  private updateRopes(dt: number): void {
    for (const rope of this.ropes) {
      for (let i = 0; i < rope.nodes.length; i++) {
        const node = rope.nodes[i];
        if (!node.alive) continue;

        if (!rope.burning[i]) {
          // 火源に触れたら着火する。
          for (const f of this.fires) {
            if (distance(node.px, node.py, f.x, f.y) <= f.r) {
              rope.burning[i] = true;
              this.events.push({ type: 'ignite', x: node.px, y: node.py });
              break;
            }
          }
        }

        if (rope.burning[i]) {
          rope.burn[i] += BURN_RATE * dt;
          // 燃えている箇所自体が火源になり、隣へ燃え広がる。半径はノード間隔
          // より必ず大きくすること。小さいと火が隣に届かず燃え進まない。
          this.fires.push({ x: node.px, y: node.py, r: BURN_SPREAD_RADIUS });
          if (rope.burn[i] >= 1) {
            // 燃え尽きたノードで綱が切れる。
            node.alive = false;
            rope.severed = true;
            for (const seg of rope.segments) {
              if (seg.a === node || seg.b === node) seg.broken = true;
            }
            for (const pin of rope.pins) {
              if (pin.a === node || pin.b === node) pin.broken = true;
            }
            if (rope.spine) rope.spine.broken = true;
          }
        }
      }
      // 燃えているノードは fires に積まれているので、そこから爆弾へ火が移る
      // 処理は updateBombs がまとめて見ている。
    }
  }

  private updateBombs(dt: number): void {
    for (const bomb of this.bombs) {
      if (bomb.exploded) continue;
      if (!bomb.ignited) {
        for (const f of this.fires) {
          if (distance(bomb.body.px, bomb.body.py, f.x, f.y) <= f.r + bomb.body.radius) {
            bomb.ignited = true;
            this.events.push({ type: 'ignite', x: bomb.body.px, y: bomb.body.py });
            break;
          }
        }
      }
      if (!bomb.ignited) continue;
      bomb.fuse -= dt;
      if (bomb.fuse <= 0) this.explode(bomb);
    }
  }

  private explode(bomb: BombEntity): void {
    bomb.exploded = true;
    const ex = bomb.body.px;
    const ey = bomb.body.py;
    this.world.remove(bomb.body);
    this.events.push({ type: 'explosion', x: ex, y: ey, r: BLAST_RADIUS });

    // 爆風は距離で減衰する衝撃を与える。
    for (const body of this.world.bodies) {
      if (!body.alive || body.isStatic || body.invMass === 0) continue;
      const d = distance(ex, ey, body.px, body.py);
      if (d > BLAST_RADIUS) continue;
      const falloff = 1 - d / BLAST_RADIUS;
      const dx = d > 1e-6 ? (body.px - ex) / d : 0;
      const dy = d > 1e-6 ? (body.py - ey) / d : -1;
      const power = BLAST_POWER * falloff * body.invMass;
      body.vx += dx * power;
      body.vy += dy * power;
    }

    // 風船は割れる。
    for (const balloon of this.balloons) {
      if (balloon.popped) continue;
      if (distance(ex, ey, balloon.body.px, balloon.body.py) <= BLAST_RADIUS) {
        this.popBalloon(balloon);
      }
    }

    // 爆風は火源でもある。ロープに引火し、他の爆弾を誘爆させる。
    this.fires.push({ x: ex, y: ey, r: BLAST_RADIUS * 0.6 });
    for (const other of this.bombs) {
      if (other === bomb || other.ignited) continue;
      if (distance(ex, ey, other.body.px, other.body.py) <= BLAST_RADIUS) {
        other.ignited = true;
      }
    }

    // 鳥は驚いて飛び立つ。
    for (const bird of this.birds) {
      if (bird.state !== 'perched') continue;
      if (distance(ex, ey, bird.x, bird.y) <= STARTLE_RADIUS) {
        bird.state = 'startled';
        bird.timer = 0.25;
      }
    }
  }

  private popBalloon(balloon: BalloonEntity): void {
    balloon.popped = true;
    this.events.push({ type: 'pop', x: balloon.body.px, y: balloon.body.py });
    this.world.remove(balloon.body);
  }

  private updateBalloons(): void {
    for (const balloon of this.balloons) {
      if (balloon.popped) continue;
      // 棘に触れたら割れる。
      for (const c of this.world.touching(balloon.body)) {
        if (c.other.tag === 'thorn') {
          this.popBalloon(balloon);
          break;
        }
      }
    }
  }

  private updateWalkers(dt: number): void {
    const { h } = this.stage.world.bounds;
    for (const w of this.walkers) {
      if (w.state === 'won' || w.state === 'dead') continue;
      const body = w.body;

      // 画面下へ落ちたら失敗。
      if (body.py > h + 40) {
        w.state = 'dead';
        this.events.push({ type: 'die', x: body.px, y: body.py });
        continue;
      }
      // 棘に触れても失敗。
      for (const c of this.world.touching(body)) {
        if (c.other.tag === 'thorn') {
          w.state = 'dead';
          this.events.push({ type: 'die', x: body.px, y: body.py });
          break;
        }
      }
      if (w.state === 'dead') continue;

      if (w.turnCooldown > 0) w.turnCooldown -= dt;
      if (w.climbCooldown > 0) w.climbCooldown -= dt;

      // ロープの上り下りは、壁の判定より先に処理する。そうしないと垂らした
      // ロープの手前で「壁だ」と判断して引き返してしまう。
      if (this.updateClimb(w, dt)) continue;

      const ground = this.world.groundContact(body);
      const wasGrounded = w.grounded;
      w.grounded = ground !== null;
      if (!wasGrounded && w.grounded) {
        this.events.push({ type: 'land', x: body.px, y: body.py });
      }

      if (w.grounded) {
        w.state = 'walk';
        // 進行方向に壁がある場合、低い段差なら登り、高い壁なら引き返す。
        // 板は地形の上に「乗る」ので必ず段差ができる。ここで登れないと
        // ほとんどの配置が成立しなくなるため、この処理は本質的。
        if (w.turnCooldown <= 0) {
          for (const c of this.world.touching(body)) {
            const facingWall = Math.abs(c.nx) > 0.7 && Math.sign(c.nx) === Math.sign(w.dir);
            // 吊り橋の踏み板は、傾いていても床であって壁ではない。たわんだ橋の
            // 一番急なところは端なので、ここを壁と見て引き返すと永遠に渡れない。
            if (!facingWall || c.other.tag === 'rope' || c.other.tag === 'plank') continue;
            const feet = body.py + 12;
            const rise = feet - bodyTop(c.other);
            if (rise > 0 && rise <= STEP_HEIGHT) {
              body.py -= rise + 0.5;
              body.vy = Math.min(body.vy, 0);
            } else {
              w.dir = -w.dir;
              w.turnCooldown = 0.25;
            }
            break;
          }
        }
        // 接地しているときだけ歩く。空中では慣性のまま飛ぶ。
        // 速度を直接書き換えず、摩擦ソルバへの「希望速度」として渡す。
        body.driveActive = true;
        body.driveVx = w.dir * WALK_SPEED;
      } else {
        w.state = 'fall';
        body.driveActive = false;
      }
    }
  }

  /**
   * ロープにつかまって登る。
   *
   * 歩くだけでは高いところへ行けないので、縦方向の移動はロープが担う。
   * 掴んでいる間は重力を打ち消し、一定速度で上る。上端まで来たら進行方向へ
   * 手を離す。true を返したら、その動物のこのステップの処理は終わり。
   */
  private updateClimb(w: WalkerEntity, dt: number): boolean {
    const body = w.body;

    if (w.state === 'climb') {
      const node = this.ropeNodeNear(body, CLIMB_HOLD_MARGIN);
      if (!node) {
        this.releaseRope(w);
        return false;
      }
      // 掴んでいる間だけ重力を相殺し、素直に一定速度で上る。
      body.buoyancy = this.world.gravity;
      body.vy = -CLIMB_SPEED;
      body.vx = (node.px - body.px) * 6;
      body.driveActive = false;

      // 掴んでいるロープの上端。
      let top = Infinity;
      const rope = node.owner as RopeEntity;
      for (const n of rope.nodes) if (n.alive) top = Math.min(top, n.py);

      // これ以上登れないなら手を離す。上端に頭が届いた場合のほか、風船など
      // 障害物につかえて高度が上がらなくなった場合もここで拾う。
      if (body.py - CLIMB_HEAD > top) {
        this.climbStallCheck(w, dt);
      } else {
        w.climbStall = CLIMB_STALL_LIMIT;
      }

      // 上端では進行方向へ飛び移る。真下に落とすだけだと、すぐ隣の足場にも
      // 移れず登った意味がなくなる。
      if (w.climbStall >= CLIMB_STALL_LIMIT) {
        this.releaseRope(w);
        body.vx = w.dir * CLIMB_HOP_VX;
        body.vy = -CLIMB_HOP_VY;
      }
      return true;
    }

    if (w.climbCooldown > 0) return false;
    const node = this.ropeNodeNear(body, CLIMB_GRAB_MARGIN);
    if (!node) return false;
    // 足元がロープの下端より下にあるときだけ掴む（上から乗ったときは掴まない）。
    w.state = 'climb';
    w.grounded = false;
    return true;
  }

  /** 登っているのに高度が上がらない時間を測る。 */
  private climbStallCheck(w: WalkerEntity, dt: number): void {
    if (w.climbLastY - w.body.py < CLIMB_SPEED * dt * 0.4) w.climbStall += dt;
    else w.climbStall = 0;
    w.climbLastY = w.body.py;
  }

  private releaseRope(w: WalkerEntity): void {
    w.state = 'fall';
    w.grounded = false;
    w.climbCooldown = 0.5;
    w.climbStall = 0;
    w.body.buoyancy = 0;
  }

  /** 動物の当たり判定に margin だけ余裕を持たせた範囲にあるロープのノード。 */
  private ropeNodeNear(body: Body, margin: number): Body | null {
    let best: Body | null = null;
    let bestY = Infinity;
    for (const rope of this.ropes) {
      for (const n of rope.nodes) {
        if (!n.alive) continue;
        const dx = Math.abs(n.px - body.px) - 8;
        const dy = Math.abs(n.py - body.py) - 12;
        if (dx <= margin && dy <= margin && n.py < bestY) {
          bestY = n.py;
          best = n;
        }
      }
    }
    return best;
  }

  private updateBirds(dt: number): void {
    const bounds = this.stage.world.bounds;
    for (const bird of this.birds) {
      switch (bird.state) {
        case 'startled':
          bird.timer -= dt;
          if (bird.timer <= 0) {
            bird.state = 'flying';
            // 決定論を保つため乱数は使わない。近い方の画面端へ抜ける。
            bird.vx = bird.x < bounds.w / 2 ? -110 : 110;
            bird.vy = -70;
            this.events.push({ type: 'flyaway', x: bird.x, y: bird.y });
          }
          break;
        case 'flying':
          bird.x += bird.vx * dt;
          bird.y += bird.vy * dt;
          bird.vy -= 18 * dt;
          if (bird.x < -40 || bird.x > bounds.w + 40 || bird.y < -40) {
            bird.state = 'gone';
          }
          break;
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 判定
  // -------------------------------------------------------------------------

  private goalRects(): { x: number; y: number; hw: number; hh: number }[] {
    return (this.stage.props ?? [])
      .filter((p) => p.type === 'goal')
      .map((p) => ({ x: p.x, y: p.y, hw: p.hw ?? 20, hh: p.hh ?? 24 }));
  }

  private checkMission(): void {
    const m = this.stage.mission;

    // 保護対象が死んだら即失敗。
    for (const w of this.walkers) {
      if (w.state === 'dead' && (this.stage.protect ?? []).includes(w.type)) {
        this.fail(`${w.type} を失った`);
        return;
      }
    }

    if (m.type === 'reach_goal') {
      const rects = this.goalRects();
      const targets = this.walkers.filter((w) => w.type === m.target);
      if (targets.length === 0) return;
      for (const w of targets) {
        if (w.state === 'won' || w.state === 'dead') continue;
        for (const g of rects) {
          if (
            Math.abs(w.body.px - g.x) <= g.hw + 8 &&
            Math.abs(w.body.py - g.y) <= g.hh + 12
          ) {
            w.state = 'won';
            this.events.push({ type: 'goal', x: w.body.px, y: w.body.py });
            break;
          }
        }
      }
      if (targets.every((w) => w.state === 'won')) {
        this.status = 'won';
        return;
      }
      // 対象が全滅したら失敗。
      if (targets.every((w) => w.state === 'dead' || w.state === 'won')) {
        this.fail('動物がゴールにたどり着けなかった');
      }
      return;
    }

    if (m.type === 'clear_all') {
      if (m.target === 'bird') {
        if (this.birds.length > 0 && this.birds.every((b) => b.state === 'gone')) {
          this.status = 'won';
        }
      }
      return;
    }

    if (m.type === 'trigger') {
      const prop = this.props.find((p) => p.id === m.target);
      if (!prop) return;
      for (const body of this.world.bodies) {
        if (!body.alive || body.isStatic) continue;
        if (distance(body.px, body.py, prop.def.x, prop.def.y) < (prop.def.hw ?? 16)) {
          this.status = 'won';
          return;
        }
      }
    }
  }

  /**
   * 時間切れと「全部止まってしまった」状態の検出。
   * 失敗コストはゼロにしたいので、決着がつかないと分かった時点で早めに返す。
   */
  private checkStall(dt: number): void {
    if (this.status !== 'running') return;

    const limit = this.stage.world.timeLimit ?? 60;
    if (this.time >= limit) {
      this.fail('時間切れ');
      return;
    }

    // 歩いている動物がいるうちは決着の可能性が残っている。
    const someoneMoving = this.walkers.some((w) => w.state === 'walk' || w.state === 'fall');
    if (someoneMoving) {
      this.stillTime = 0;
      return;
    }
    const busy =
      this.bombs.some((b) => b.ignited && !b.exploded) ||
      this.ropes.some((r) => r.burning.some((v) => v)) ||
      this.birds.some((b) => b.state === 'startled' || b.state === 'flying');
    if (busy) {
      this.stillTime = 0;
      return;
    }

    let energy = 0;
    for (const b of this.world.bodies) {
      if (!b.alive || b.isStatic) continue;
      energy += b.vx * b.vx + b.vy * b.vy;
    }
    if (energy < 40) {
      this.stillTime += dt;
      if (this.stillTime > 1.2) this.fail('連鎖が止まってしまった');
    } else {
      this.stillTime = 0;
    }
  }

  private fail(reason: string): void {
    this.status = 'lost';
    this.failReason = reason;
  }

  /**
   * 現在の状態。step() は status を書き換えるが、呼び出し側で
   * `sim.status === 'running'` と比較すると TS がその型に絞り込んだままに
   * なってしまうため、読み出しはメソッド経由にする。
   */
  getStatus(): SimStatus {
    return this.status;
  }

  /** 描画側が読み取ったイベントを消費する。 */
  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/** body の最上端の y 座標（画面座標なので値が小さいほど上）。 */
export function bodyTop(body: Body): number {
  if (body.kind === 'circle') return body.py - body.radius;
  let top = Infinity;
  for (const v of body.world) top = Math.min(top, v.y);
  return top;
}

/**
 * body の表面上で、点 (tx,ty) に最も近い場所を返す。
 * ロープの接続点をここで決めることで、板の端に繋げば端から吊られて傾く、
 * という直感どおりの結果になる。
 */
export function surfacePoint(body: Body, tx: number, ty: number): Vec {
  if (body.kind === 'circle') {
    const dx = tx - body.px;
    const dy = ty - body.py;
    const d = length(dx, dy);
    if (d < 1e-6) return { x: body.px, y: body.py - body.radius };
    return { x: body.px + (dx / d) * body.radius, y: body.py + (dy / d) * body.radius };
  }
  // 多角形はローカル空間で AABB にクランプしてから戻す。
  const local = toLocal(body, tx, ty);
  let hw = 0;
  let hh = 0;
  for (const v of body.localVerts) {
    hw = Math.max(hw, Math.abs(v.x));
    hh = Math.max(hh, Math.abs(v.y));
  }
  const cx = Math.max(-hw, Math.min(hw, local.x));
  const cy = Math.max(-hh, Math.min(hh, local.y));
  return toWorld(body, cx, cy);
}

/** ロープの接続先候補を列挙する（配置 UI のハイライト用）。 */
export function anchorCandidates(
  stage: StageDef,
  placements: PlacementDef[],
): AnchorInfo[] {
  const out: AnchorInfo[] = [];
  /** 2 点を繋ぐ物の掴み所を出すために、全ての点の位置を引けるようにしておく。 */
  const pos = new Map<string, Vec>();

  for (const p of stage.props ?? []) {
    if (p.type !== 'anchor' && p.type !== 'campfire') continue;
    const id = p.id ?? p.type;
    pos.set(id, { x: p.x, y: p.y });
    out.push({ id, x: p.x, y: p.y, attachable: true });
  }

  for (const p of placements) {
    if (ITEMS[p.item].spans) continue;
    pos.set(p.id, { x: p.x, y: p.y });
    if (!ITEMS[p.item].attach) continue;
    out.push({ id: p.id, x: p.x, y: p.y, attachable: true });
  }

  // 吊り橋の掴み所は真ん中。ここを吊れば、たわみを持ち上げられる。
  // 位置は架け渡した 2 点の中点でよい。配置中の橋はまだ垂れていない。
  for (const p of placements) {
    if (!ITEMS[p.item].spans || !ITEMS[p.item].attach) continue;
    const a = p.from && pos.get(p.from.target);
    const b = p.to && pos.get(p.to.target);
    if (!a || !b) continue;
    out.push({ id: p.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, attachable: true });
  }

  return out;
}

export const COLLISION_CATEGORIES = { CAT_STATIC, CAT_DYNAMIC, CAT_ROPE, CAT_ACTOR, CAT_ALL };

/**
 * スケルタルアニメーション。
 *
 * 1 枚のキャラクター画像を部位（頭・胴・腕・脚・しっぽ）に切り分け、
 * 関節を軸に回転させて動かす。コマ割りの絵を使わないので、
 *
 *  - コマ間で体格や位置がブレることが原理的に起きない
 *  - 歩幅を移動距離に完全に同期できる（早送り・一時停止でもずれない）
 *
 * 画像生成AIはコマ間の一貫性が苦手だが「1 枚の立ち絵」は得意なので、
 * この方式ならその弱点を回避できる。
 */

export interface RigPartDef {
  name: string;
  /** 元画像の切り出し矩形 [x, y, w, h]（画像ピクセル座標）。 */
  rect: [number, number, number, number];
  /** 回転の軸。関節の位置を画像ピクセル座標で指定する。 */
  pivot: [number, number];
  /** 重ね順。小さいほど奥。 */
  z: number;
  /**
   * クリップごとの動き。
   *  swing: 回転の振れ幅（ラジアン）
   *  phase: 位相のずれ（1 周を 1.0 とする。前脚と後脚は 0.5 ずらす）
   *  lift:  上下の振れ幅（px）。胴の上下動などに使う
   */
  anim?: Record<string, { swing?: number; phase?: number; lift?: number }>;
}

export interface RigDef {
  src: string;
  /** 足元の位置（画像ピクセル座標）。ここが地面に接する。 */
  anchor: [number, number];
  /** 論理座標へ描くときの倍率。 */
  scale: number;
  /** 1 周期あたりの移動距離(px)。歩幅。 */
  strideLength: number;
  parts: RigPartDef[];
}

export type RigManifest = Record<string, RigDef>;

export class Rig {
  private sorted: RigPartDef[];

  constructor(
    readonly def: RigDef,
    readonly image: HTMLImageElement,
  ) {
    this.sorted = [...def.parts].sort((a, b) => a.z - b.z);
  }

  /**
   * 足元 (x, y) に、指定クリップの位相 phase(0..1) で描く。
   * @param flip 左を向かせるなら true。
   */
  draw(
    ctx: CanvasRenderingContext2D,
    clip: string,
    phase: number,
    x: number,
    y: number,
    flip: boolean,
  ): void {
    const { anchor, scale } = this.def;
    const cycle = phase * Math.PI * 2;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(flip ? -scale : scale, scale);

    for (const part of this.sorted) {
      const a = part.anim?.[clip];
      const swing = a?.swing ?? 0;
      const lift = a?.lift ?? 0;
      const offset = (a?.phase ?? 0) * Math.PI * 2;
      const angle = swing === 0 ? 0 : Math.sin(cycle + offset) * swing;
      const dy = lift === 0 ? 0 : Math.abs(Math.sin(cycle + offset)) * lift;

      const [rx, ry, rw, rh] = part.rect;
      const [pxImg, pyImg] = part.pivot;
      // 関節を原点に持っていって回し、元の位置関係で描き戻す。
      const jointX = pxImg - anchor[0];
      const jointY = pyImg - anchor[1];

      ctx.save();
      ctx.translate(jointX, jointY + dy);
      if (angle !== 0) ctx.rotate(angle);
      ctx.drawImage(this.image, rx, ry, rw, rh, rx - pxImg, ry - pyImg, rw, rh);
      ctx.restore();
    }

    ctx.restore();
  }

  /** 移動距離から歩行位相を求める。速度が変わっても歩幅は破綻しない。 */
  phaseFromDistance(distance: number): number {
    const stride = this.def.strideLength || 40;
    return (distance / stride) % 1;
  }
}

export type RigSet = Map<string, Rig>;

/**
 * public/sprites/rig.json を読む。無ければ空の Map を返し、
 * 描画はスプライトシート、さらに無ければ手続き的描画へ落ちる。
 */
export async function loadRigs(baseUrl: string): Promise<RigSet> {
  const set: RigSet = new Map();
  let manifest: RigManifest;
  try {
    const res = await fetch(`${baseUrl}sprites/rig.json`);
    if (!res.ok) return set;
    manifest = (await res.json()) as RigManifest;
  } catch {
    return set;
  }

  await Promise.all(
    Object.entries(manifest).map(async ([name, def]) => {
      try {
        const image = await loadImage(`${baseUrl}sprites/${def.src}`);
        set.set(name, new Rig(def, image));
      } catch {
        console.warn(`リグ画像を読み込めませんでした: ${def.src}`);
      }
    }),
  );
  return set;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(src));
    img.src = src;
  });
}

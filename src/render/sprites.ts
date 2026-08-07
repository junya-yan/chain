/**
 * キャラクター画像（スプライト）の読み込みと描画。
 *
 * 画像は必須ではない。manifest.json や画像が無ければ黙って諦め、Renderer の
 * 手続き的描画にそのまま戻る。絵ができたものから 1 体ずつ差し替えられる。
 *
 * アニメのコマ送りは「時計」ではなく「ゲームの状態」で決める。歩きは移動距離、
 * 登りは高度に同期させる。早送り(2x/4x)や一時停止でも絵と物理がずれない。
 */

export interface ClipDef {
  /** シート上の行番号（0 始まり）。 */
  row: number;
  /** その行に並ぶコマ数。 */
  frames: number;
  /** 時間で送る場合のコマ/秒。省略時は状態から算出する。 */
  fps?: number;
  /**
   * 移動何 px ごとに 1 コマ進めるか。歩き・登りに使う。
   * これを指定すると fps より優先され、移動に同期する。
   */
  perPixels?: number;
}

export interface SpriteDef {
  /** public/sprites/ からの相対パス。 */
  src: string;
  frameW: number;
  frameH: number;
  /**
   * コマ内の基準点。動物では「足元の中心」にすると地面にきれいに立つ。
   * 省略時はコマの中央下。
   */
  anchorX?: number;
  anchorY?: number;
  /** 論理座標へ描くときの倍率。 */
  scale?: number;
  clips: Record<string, ClipDef>;
}

export type SpriteManifest = Record<string, SpriteDef>;

export class Sprite {
  constructor(
    readonly def: SpriteDef,
    readonly image: HTMLImageElement,
  ) {}

  get scale(): number {
    return this.def.scale ?? 1;
  }

  private anchorX(): number {
    return this.def.anchorX ?? this.def.frameW / 2;
  }

  private anchorY(): number {
    return this.def.anchorY ?? this.def.frameH;
  }

  has(clip: string): boolean {
    return clip in this.def.clips;
  }

  /**
   * 基準点 (x,y) にコマを描く。
   * @param progress アニメの進行度。clip の指定に応じて距離や秒数を渡す。
   * @param flip 左を向かせるなら true。
   */
  draw(
    ctx: CanvasRenderingContext2D,
    clip: string,
    progress: number,
    x: number,
    y: number,
    flip: boolean,
  ): boolean {
    const def = this.def.clips[clip];
    if (!def) return false;
    const { frameW, frameH } = this.def;

    let index: number;
    if (def.perPixels) index = Math.floor(Math.abs(progress) / def.perPixels);
    else if (def.fps) index = Math.floor(Math.abs(progress) * def.fps);
    else index = 0;
    index = ((index % def.frames) + def.frames) % def.frames;

    const s = this.scale;
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.image,
      index * frameW,
      def.row * frameH,
      frameW,
      frameH,
      -this.anchorX() * s,
      -this.anchorY() * s,
      frameW * s,
      frameH * s,
    );
    ctx.restore();
    return true;
  }
}

export type SpriteSet = Map<string, Sprite>;

/**
 * public/sprites/manifest.json を読み、載っている画像を全部取りに行く。
 * 1 枚も無くても失敗にはしない（空の Map を返し、描画は手続き的に行われる）。
 */
export async function loadSprites(baseUrl: string): Promise<SpriteSet> {
  const set: SpriteSet = new Map();
  let manifest: SpriteManifest;
  try {
    const res = await fetch(`${baseUrl}sprites/manifest.json`);
    if (!res.ok) return set;
    manifest = (await res.json()) as SpriteManifest;
  } catch {
    return set;
  }

  await Promise.all(
    Object.entries(manifest).map(async ([name, def]) => {
      try {
        const image = await loadImage(`${baseUrl}sprites/${def.src}`);
        set.set(name, new Sprite(def, image));
      } catch {
        // その 1 体だけ手続き的描画のままにする。
        console.warn(`スプライトを読み込めませんでした: ${def.src}`);
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

/**
 * ステージ定義のスキーマ。
 *
 * ステージはすべて外部 JSON で定義し、コードを触らずに追加できる。
 * このファイルの型が JSON の唯一の仕様であり、ローダはこれに対して検証する。
 */

export type Biome = 'amazon' | 'mediterranean' | 'alaska';

/** 配置可能アイテムの種別。 */
export type ItemId =
  | 'platform' // 板。足場や斜面になる
  | 'balloon' // 風船。浮力で上昇し、繋いだ物を吊る
  | 'rope' // ロープ／導火線。2 点を接続し、火が付くと燃え進んで切れる
  | 'bomb' // 爆弾。着火後に爆発する
  | 'spring' // ばね。触れた物を弾く
  | 'weight' // 錘。重い
  | 'pulley'; // 滑車。ロープが乗って向きを変える

/** 地形（静的剛体）。 */
export interface TerrainDef {
  /** 見た目の材質。当たり判定には影響しない。 */
  material: 'rock' | 'wood' | 'ice' | 'foliage';
  x: number;
  y: number;
  /** 矩形として定義する場合。 */
  hw?: number;
  hh?: number;
  /** ラジアン。斜面を作るときに使う。 */
  angle?: number;
  /** 任意の凸多角形として定義する場合（重心まわりのローカル座標・時計回り）。 */
  verts?: { x: number; y: number }[];
  friction?: number;
}

/** 動物。プレイヤーは操作しない。自律的に動く。 */
export interface ActorDef {
  type: 'lion' | 'bird';
  x: number;
  y: number;
  /** 歩き出す向き。1 が右、-1 が左。 */
  dir?: 1 | -1;
  /** 見た目のバリエーション。 */
  variant?: string;
}

/** 固定オブジェクト。 */
export interface PropDef {
  type: 'goal' | 'campfire' | 'thorn' | 'anchor';
  /** ロープの接続先として参照するための名前。 */
  id?: string;
  x: number;
  y: number;
  hw?: number;
  hh?: number;
}

export interface InventoryEntry {
  item: ItemId;
  count: number;
}

export type MissionDef =
  /** 指定種別の動物を全てゴールへ到達させる。 */
  | { type: 'reach_goal'; target: string }
  /** 指定種別を全て排除／飛び立たせる。 */
  | { type: 'clear_all'; target: string }
  /** 指定スイッチを作動させる。 */
  | { type: 'trigger'; target: string };

export interface StageDef {
  id: string;
  name: string;
  biome: Biome;
  /** 目標の説明文。開始時にオーバーレイで提示する。 */
  brief: string;
  mission: MissionDef;
  /** これらのタグを持つ動物が死ぬと即失敗になる。 */
  protect?: string[];
  world: {
    gravity: number;
    wind?: number;
    bounds: { w: number; h: number };
    /** シミュレーション時間の上限（秒）。超えたら失敗。 */
    timeLimit?: number;
  };
  terrain: TerrainDef[];
  actors: ActorDef[];
  props?: PropDef[];
  inventory: InventoryEntry[];
  /** 想定解のアイテム数。 */
  par: number;
  hints?: string[];
  /**
   * 検証用の想定解。tools/verify-stages.ts がこれを再生して
   * 「このステージは本当にクリア可能か」を自動で確かめる。
   */
  solution?: PlacementDef[];
}

/** ロープの接続先。配置済みアイテムの id か、ステージ上の prop の id。 */
export interface AnchorRef {
  target: string;
}

/** プレイヤーが置いた 1 個のアイテム。 */
export interface PlacementDef {
  /** 配置ごとの一意な ID。ロープの接続先として参照される。 */
  id: string;
  item: ItemId;
  x: number;
  y: number;
  /** ラジアン。板を斜面にするときに使う。 */
  angle?: number;
  /** item === 'rope' のときのみ。両端の接続先。 */
  from?: AnchorRef;
  to?: AnchorRef;
}

/**
 * アイテムの物理的な素性。
 *
 * 挙動は「見ればわかる」ことを最優先に調整する。数値の意味:
 *  - buoyancyScale: 重力の何倍の浮力を上向きに受けるか。1 を超えると浮く。
 *  - attach: ロープで繋げられるか。
 */

import type { ItemId } from './types';

export interface ItemSpec {
  label: string;
  /** パレットとヒントに出す一行説明。 */
  blurb: string;
  shape: 'box' | 'circle';
  hw: number;
  hh: number;
  radius: number;
  mass: number;
  restitution: number;
  friction: number;
  buoyancyScale: number;
  linearDamping: number;
  angularDamping: number;
  isStatic: boolean;
  attach: boolean;
  /** 火が付くか。 */
  flammable: boolean;
  /** 爆風や棘で壊れるか。 */
  fragile: boolean;
  /** プレイヤーが角度を変えられるか。 */
  rotatable: boolean;
  /** 姿勢を保つか。true なら倒れも回りもしない。 */
  fixedRotation: boolean;
  /**
   * 動物がつかまって登れるか。
   * 登るには動物と重なれないといけないので、登れる物は動物とすり抜ける
   * （Simulation がこの旗を見て衝突マスクを決める）。
   */
  climbable: boolean;
}

const DEFAULTS: ItemSpec = {
  label: '',
  blurb: '',
  shape: 'box',
  hw: 10,
  hh: 10,
  radius: 10,
  mass: 1,
  restitution: 0.05,
  friction: 0.6,
  buoyancyScale: 0,
  linearDamping: 0.05,
  angularDamping: 0.1,
  isStatic: false,
  attach: false,
  flammable: false,
  fragile: false,
  rotatable: false,
  fixedRotation: false,
  climbable: false,
};

export const ITEMS: Record<ItemId, ItemSpec> = {
  platform: {
    ...DEFAULTS,
    label: '板',
    blurb: '足場にも斜面にもなる。傾ければ物が滑る。',
    shape: 'box',
    hw: 36,
    hh: 5,
    mass: 0.6,
    friction: 0.85,
    angularDamping: 0.6,
    attach: true,
    rotatable: true,
  },
  ladder: {
    ...DEFAULTS,
    label: 'ハシゴ',
    blurb: '動物がつかまって登る。上端まで登ったら横へ飛び移る。',
    shape: 'box',
    hw: 9,
    hh: 80,
    // 風船 1 個で吊り上がる重さにする。重すぎると「吊る」連鎖が成立しない。
    mass: 1.6,
    friction: 0.7,
    // 吊られたときの揺れを早く収める。止まる高さが読めないと配置できない。
    linearDamping: 1.2,
    attach: true,
    // 倒れたハシゴは登れず、原因も分かりにくい。姿勢は固定する。
    fixedRotation: true,
    climbable: true,
  },
  balloon: {
    ...DEFAULTS,
    label: '風船',
    blurb: '上へ浮かぶ。繋いだ物を吊り上げる。棘や爆風で割れる。',
    shape: 'circle',
    radius: 12,
    mass: 1.0,
    restitution: 0.2,
    friction: 0.3,
    // 板・爆弾に加えて、長い導火線の重さまで吊り上げられる余裕を持たせる。
    // 足りないと「風船で吊る」連鎖がぎりぎり成立せず、原因が読みにくくなる。
    buoyancyScale: 6.0,
    // 揺れが収まらないと配置の意図が読めないので、強めに減衰させる。
    linearDamping: 1.8,
    angularDamping: 2.0,
    attach: true,
    fragile: true,
  },
  rope: {
    ...DEFAULTS,
    label: 'ロープ',
    blurb: '2 点を繋ぐ。火が付くと端から燃え進み、やがて切れる。',
    shape: 'circle',
    radius: 3,
    mass: 0.1,
    friction: 0.4,
    flammable: true,
  },
  bomb: {
    ...DEFAULTS,
    label: '爆弾',
    blurb: '火が付くと少し遅れて爆発する。周りを吹き飛ばす。',
    shape: 'circle',
    radius: 10,
    mass: 1.4,
    restitution: 0.15,
    friction: 0.5,
    attach: true,
    flammable: true,
  },
  spring: {
    ...DEFAULTS,
    label: 'ばね',
    blurb: '触れた物を勢いよく弾き返す。',
    shape: 'box',
    hw: 16,
    hh: 7,
    restitution: 1.7,
    friction: 0.4,
    isStatic: true,
    rotatable: true,
  },
  weight: {
    ...DEFAULTS,
    label: '錘',
    blurb: 'とても重い。落ちて物を押しつぶす。',
    shape: 'box',
    hw: 12,
    hh: 13,
    mass: 6,
    friction: 0.7,
    attach: true,
  },
  pulley: {
    ...DEFAULTS,
    label: '滑車',
    blurb: 'ロープが乗り、力の向きを変える。',
    shape: 'circle',
    radius: 9,
    friction: 0.03,
    isStatic: true,
    attach: true,
  },
};

export const ITEM_ORDER: ItemId[] = [
  'platform',
  'ladder',
  'balloon',
  'rope',
  'bomb',
  'spring',
  'weight',
  'pulley',
];

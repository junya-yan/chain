/** 舞台ごとの配色。アセットは持たず、すべて手続き的に描く。 */

import type { Biome } from '../sim/types';

export interface Theme {
  skyTop: string;
  skyBottom: string;
  haze: string;
  far: string;
  mid: string;
  near: string;
  rock: string;
  rockLit: string;
  rockDark: string;
  moss: string;
  mossLit: string;
  wood: string;
  woodLit: string;
  woodDark: string;
  ice: string;
  iceLit: string;
}

export const THEMES: Record<Biome, Theme> = {
  amazon: {
    skyTop: '#2b1150',
    skyBottom: '#4b1f7a',
    haze: '#6c2ea0',
    far: '#3a1a63',
    mid: '#27114a',
    near: '#170a2e',
    rock: '#4a4a63',
    rockLit: '#6c6c88',
    rockDark: '#2c2c40',
    moss: '#1f5c2a',
    mossLit: '#37913f',
    wood: '#7a4a22',
    woodLit: '#b9762f',
    woodDark: '#4a2a12',
    ice: '#9fd8e8',
    iceLit: '#d8f3fb',
  },
  mediterranean: {
    skyTop: '#123a63',
    skyBottom: '#2f86b8',
    haze: '#7fc4dc',
    far: '#2a6b93',
    mid: '#1c4d6e',
    near: '#12324a',
    rock: '#b9a582',
    rockLit: '#e0cda3',
    rockDark: '#7d6d51',
    moss: '#4d7a33',
    mossLit: '#7cae4c',
    wood: '#8a5a2b',
    woodLit: '#c68a42',
    woodDark: '#553417',
    ice: '#bfe6f0',
    iceLit: '#e8f8fd',
  },
  alaska: {
    skyTop: '#16243f',
    skyBottom: '#3b5f8a',
    haze: '#8fb6d8',
    far: '#2c4460',
    mid: '#22374f',
    near: '#152234',
    rock: '#5d6a7a',
    rockLit: '#8595a6',
    rockDark: '#39434f',
    moss: '#2f5a4a',
    mossLit: '#4c8a70',
    wood: '#6a5540',
    woodLit: '#9c8161',
    woodDark: '#3f3225',
    ice: '#a9dcef',
    iceLit: '#e6f8ff',
  },
};

/**
 * 決定論的な擬似乱数。背景の装飾を毎フレーム同じ場所に描くために使う。
 * シミュレーションでは乱数を一切使わないので、これは見た目専用。
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** 文字列から安定したシードを作る。 */
export function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

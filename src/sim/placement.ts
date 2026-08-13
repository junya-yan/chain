/**
 * 配置の可否判定。
 *
 * UI と検証ツールの両方から呼ぶため、DOM に依存しない sim 層に置く。
 * ここが UI 側だけにあると、「想定解が物理的には成立するのに、実際には
 * 置けない」ステージが検証をすり抜けてしまう。
 */

import { ITEMS } from './items';
import type { ItemId, PlacementDef, StageDef } from './types';

/** 物の半径・半幅（回転を考慮した外接矩形の半サイズ）。 */
function extents(item: ItemId, angle: number): { ex: number; ey: number } {
  const spec = ITEMS[item];
  if (spec.shape === 'circle') return { ex: spec.radius, ey: spec.radius };
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  return {
    ex: spec.hw * c + spec.hh * s,
    ey: spec.hw * s + spec.hh * c,
  };
}

export function canPlace(
  stage: StageDef,
  placements: PlacementDef[],
  item: ItemId,
  x: number,
  y: number,
  angle = 0,
  ignoreId: string | null = null,
): boolean {
  // ロープや吊り橋は 2 点を繋ぐだけで、場所を占有しない。
  if (ITEMS[item].spans) return true;

  const { w, h } = stage.world.bounds;
  const { ex, ey } = extents(item, angle);
  if (x - ex < 2 || x + ex > w - 2 || y - ey < 2 || y + ey > h - 2) return false;

  for (const t of stage.terrain) {
    if (t.verts) continue; // 多角形地形はざっくり許容する
    if (Math.abs(x - t.x) < (t.hw ?? 10) + ex && Math.abs(y - t.y) < (t.hh ?? 10) + ey) {
      return false;
    }
  }

  for (const p of placements) {
    if (ITEMS[p.item].spans || p.id === ignoreId) continue;
    const other = extents(p.item, p.angle ?? 0);
    if (
      Math.abs(x - p.x) < ex + other.ex * 0.6 &&
      Math.abs(y - p.y) < ey + other.ey * 0.6
    ) {
      return false;
    }
  }

  // 歩く動物の初期位置に重ねるのは理不尽なので避ける。
  // 鳥は対象にしない。鳥のそばに爆弾を置くこと自体が狙いのステージがある。
  for (const a of stage.actors) {
    if (a.type === 'bird') continue;
    if (Math.abs(x - a.x) < ex + 14 && Math.abs(y - a.y) < ey + 18) return false;
  }

  return true;
}

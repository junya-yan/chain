/**
 * 進行データ。
 *
 * 原作コミュニティの「省アイテムチャレンジ」文化を再現したいので、
 * クリアの有無だけでなく最少使用アイテム数を残す。
 */

const KEY = 'chain.progress.v1';

export interface StageRecord {
  cleared: boolean;
  /** これまでの最少使用アイテム数。 */
  bestItems: number;
}

type Progress = Record<string, StageRecord>;

function read(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Progress) : {};
  } catch {
    // プライベートブラウジングなどで localStorage が使えなくても遊べるようにする。
    return {};
  }
}

function write(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 保存できなくてもゲームは続行できる */
  }
}

export function getRecord(stageId: string): StageRecord | null {
  return read()[stageId] ?? null;
}

export function recordClear(stageId: string, itemsUsed: number): void {
  const p = read();
  const prev = p[stageId];
  p[stageId] = {
    cleared: true,
    bestItems: prev?.cleared ? Math.min(prev.bestItems, itemsUsed) : itemsUsed,
  };
  write(p);
}

export function isCleared(stageId: string): boolean {
  return read()[stageId]?.cleared ?? false;
}

export function clearAll(): void {
  write({});
}

/**
 * ステージ JSON の読み込み。
 *
 * ステージはコードではなく public/stages/ の JSON で定義される。
 * index.json に id を足して JSON を置けば、コードを触らずステージが増える。
 */

import type { StageDef } from '../sim/types';

let cache: StageDef[] | null = null;

export async function loadStages(): Promise<StageDef[]> {
  if (cache) return cache;
  const base = import.meta.env.BASE_URL;
  const index: string[] = await fetchJson(`${base}stages/index.json`);
  const stages = await Promise.all(index.map((id) => fetchJson<StageDef>(`${base}stages/${id}.json`)));
  stages.forEach(validate);
  cache = stages;
  return stages;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ステージの読み込みに失敗: ${url} (${res.status})`);
  return (await res.json()) as T;
}

/** JSON を手で書く前提なので、壊れていたら早い段階で気づけるようにする。 */
function validate(stage: StageDef): void {
  const where = `ステージ ${stage.id ?? '(id なし)'}`;
  if (!stage.id) throw new Error(`${where}: id がない`);
  if (!stage.world?.bounds) throw new Error(`${where}: world.bounds がない`);
  if (!Array.isArray(stage.terrain)) throw new Error(`${where}: terrain がない`);
  if (!Array.isArray(stage.actors) || stage.actors.length === 0) {
    throw new Error(`${where}: actors が空`);
  }
  if (stage.mission.type === 'reach_goal') {
    const hasGoal = (stage.props ?? []).some((p) => p.type === 'goal');
    if (!hasGoal) throw new Error(`${where}: reach_goal なのに goal が置かれていない`);
  }
}

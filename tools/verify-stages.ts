/**
 * ステージのクリア可能性をヘッドレスで検証する。
 *
 * 各ステージ JSON の `solution` を再生してシミュレーションを回し、
 * 本当に `won` に到達するかを確かめる。物理パズルは目視で「解けるはず」と
 * 思い込みやすいので、想定解を機械で毎回踏ませる。
 *
 *   npm run verify
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXED_DT, Simulation } from '../src/sim/simulation';
import { canPlace } from '../src/sim/placement';
import type { PlacementDef, StageDef } from '../src/sim/types';

const STAGE_DIR = join(process.cwd(), 'public', 'stages');
const MAX_SECONDS = 90;

function loadStages(): StageDef[] {
  const index: string[] = JSON.parse(readFileSync(join(STAGE_DIR, 'index.json'), 'utf8'));
  const known = new Set(
    readdirSync(STAGE_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => f.replace(/\.json$/, '')),
  );
  for (const id of index) {
    if (!known.has(id)) throw new Error(`index.json が存在しないステージを参照している: ${id}`);
  }
  for (const id of known) {
    if (!index.includes(id)) console.warn(`  ! ${id}.json が index.json に載っていない`);
  }
  return index.map((id) => JSON.parse(readFileSync(join(STAGE_DIR, `${id}.json`), 'utf8')));
}

interface Outcome {
  status: string;
  seconds: number;
  reason: string;
}

function run(stage: StageDef, placements: StageDef['solution']): Outcome {
  const sim = new Simulation(stage, placements ?? []);
  const maxSteps = Math.ceil(MAX_SECONDS / FIXED_DT);
  for (let i = 0; i < maxSteps && sim.status === 'running'; i++) sim.step();
  return { status: sim.status, seconds: sim.time, reason: sim.failReason };
}

function main(): void {
  const stages = loadStages();
  let failed = 0;

  for (const stage of stages) {
    const label = `${stage.id} (${stage.name})`;

    if (!stage.solution || stage.solution.length === 0) {
      console.log(`  ? ${label}: solution が未定義。検証をスキップ`);
      continue;
    }

    // 1. 想定解が「実際に置ける」こと。
    //    物理的には成立するのに UI では置けない、というステージを弾く。
    //    配置ルールは sim 層に置いてあるので、ここから同じ判定を呼べる。
    const laid: PlacementDef[] = [];
    let illegal: PlacementDef | null = null;
    for (const p of stage.solution) {
      if (!canPlace(stage, laid, p.item, p.x, p.y, p.angle ?? 0, p.id)) {
        illegal = p;
        break;
      }
      laid.push(p);
    }
    if (illegal) {
      console.log(
        `  X ${label}: solution の ${illegal.item} (${illegal.x},${illegal.y}) は配置ルールで置けない`,
      );
      failed++;
    }

    // 2. 想定解でクリアできること。
    const solved = run(stage, stage.solution);
    if (solved.status === 'won') {
      console.log(`  o ${label}: ${solved.seconds.toFixed(1)}s でクリア`);
    } else {
      console.log(`  X ${label}: 想定解でクリアできない (${solved.status} / ${solved.reason})`);
      failed++;
    }

    // 3. 何も置かなければ失敗すること。置く意味のないステージを検出する。
    const empty = run(stage, []);
    if (empty.status === 'won') {
      console.log(`  X ${label}: 何も置かなくてもクリアできてしまう`);
      failed++;
    }

    // 4. アイテム数が par 以下であること。
    if (stage.solution.length > stage.par) {
      console.log(`  X ${label}: solution が ${stage.solution.length} 個で par ${stage.par} を超えている`);
      failed++;
    }

    // 5. 決定論。同じ配置を2回流して完全に一致すること。
    const again = run(stage, stage.solution);
    if (again.status !== solved.status || Math.abs(again.seconds - solved.seconds) > 1e-9) {
      console.log(`  X ${label}: 実行ごとに結果が違う（決定論が壊れている）`);
      failed++;
    }
  }

  console.log('');
  if (failed > 0) {
    console.log(`${failed} 件の問題があります`);
    process.exit(1);
  }
  console.log(`${stages.length} ステージすべて検証を通過`);
}

main();

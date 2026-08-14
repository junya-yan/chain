/**
 * 画面遷移の入口。タイトル → ステージセレクト → メインゲーム。
 */

import './style.css';
import { loadStages } from './game/stages';
import { getRecord } from './game/save';
import { GameScreen } from './ui/game-screen';
import { createCreditsScreen } from './ui/credits';
import { loadSprites, type SpriteSet } from './render/sprites';
import { loadRigs, type RigSet } from './render/rig';
import type { StageDef } from './sim/types';

const root = document.getElementById('app')!;
let stages: StageDef[] = [];
let sprites: SpriteSet = new Map();
let rigs: RigSet = new Map();
let current: GameScreen | null = null;

function clear(): void {
  current?.destroy();
  current = null;
  root.innerHTML = '';
}

function showTitle(): void {
  clear();
  const el = document.createElement('div');
  el.className = 'screen';
  el.innerHTML = `
    <h1 class="logo">CHAIN</h1>
    <p class="superscript">THE CHAIN REACTION GAME</p>
    <p class="tagline">因果を組み立てる物理パズル</p>
    <div class="row">
      <button class="primary" data-act="start">ゲーム開始</button>
    </div>
    <p class="tagline" style="max-width:34ch;line-height:1.8">
      動物は勝手に歩き出す。止めることはできない。<br />
      アイテムを置いて、道を作ってやろう。
    </p>
    <button class="link-quiet" data-act="credits">権利とクレジット</button>
  `;
  el.querySelector('[data-act="start"]')!.addEventListener('click', showSelect);
  el.querySelector('[data-act="credits"]')!.addEventListener('click', showCredits);
  root.append(el);
}

function showCredits(): void {
  clear();
  root.append(createCreditsScreen({ onBack: showTitle }));
}

function showSelect(): void {
  clear();
  const el = document.createElement('div');
  el.className = 'screen';
  el.innerHTML = `<h1 class="logo" style="font-size:2.2rem">ステージ</h1>`;

  const grid = document.createElement('div');
  grid.className = 'stage-grid';
  stages.forEach((stage, i) => {
    const rec = getRecord(stage.id);
    const card = document.createElement('button');
    card.className = 'stage-card' + (rec?.cleared ? ' cleared' : '');
    card.innerHTML = `
      <span class="no">${String(i + 1).padStart(2, '0')}</span>
      <span class="title">${stage.name}</span>
      <span class="record">${rec?.cleared ? `最少 ${rec.bestItems} 個 / 目標 ${stage.par}` : `目標 ${stage.par} 個`}</span>
      ${rec?.cleared ? '<span class="check">★</span>' : ''}
    `;
    card.addEventListener('click', () => showGame(i));
    grid.append(card);
  });
  el.append(grid);

  const back = document.createElement('button');
  back.textContent = 'タイトルへ';
  back.addEventListener('click', showTitle);
  el.append(back);

  root.append(el);
}

function showGame(index: number): void {
  clear();
  const screen = new GameScreen(stages[index], {
    onExit: showSelect,
    onNextStage: () => {
      if (index + 1 < stages.length) showGame(index + 1);
      else showSelect();
    },
    hasNextStage: () => index + 1 < stages.length,
  });
  screen.setArt(rigs, sprites);
  current = screen;
  root.append(screen.el);
}

async function boot(): Promise<void> {
  root.innerHTML = '<div class="screen"><p class="tagline">読み込み中…</p></div>';
  try {
    // スプライトは任意。無ければ手続き的描画のまま遊べるので、失敗しても止めない。
    const base = import.meta.env.BASE_URL;
    const [loaded, loadedRigs, loadedSprites] = await Promise.all([
      loadStages(),
      loadRigs(base),
      loadSprites(base),
    ]);
    stages = loaded;
    rigs = loadedRigs;
    sprites = loadedSprites;
    showTitle();
  } catch (err) {
    root.innerHTML = `<div class="screen"><h1 class="logo" style="font-size:1.6rem">読み込みに失敗</h1><p>${
      err instanceof Error ? err.message : String(err)
    }</p></div>`;
  }
}

void boot();

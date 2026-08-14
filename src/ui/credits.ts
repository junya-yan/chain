/**
 * 権利とクレジットの画面。
 *
 * 内容は README.ja.md の「権利とクレジット」節と同じことを書いている。
 * README を読まない遊び手にも、原作との関係と素材の出自が届くようにするため。
 */

const REPO_URL = 'https://github.com/junya-yan/chain';

export interface CreditsScreenHandlers {
  onBack(): void;
}

export function createCreditsScreen(handlers: CreditsScreenHandlers): HTMLElement {
  const el = document.createElement('div');
  el.className = 'screen screen-doc';
  el.innerHTML = `
    <article class="doc">
      <h1>権利とクレジット</h1>
      <p class="lead"><strong>CHAIN</strong> は個人の習作として公開しているブラウザゲーム。商用利用は目的としていない。</p>

      <h2>原作との関係</h2>
      <!-- 日本語の途中で改行するとブラウザが空白として描くので、1 文は 1 行に書く。 -->
      <p>ダイソー「ザ・ゲームシリーズ」の『パズリング』（No.29〜31）に<strong>着想を得ているだけ</strong>で、原作とは無関係の別作品。原作からは何ひとつ持ち込んでいない。</p>
      <ul>
        <li>名称を使っていない（原作名を避けて <code>CHAIN</code> としている）</li>
        <li>画像・音・コードを一切流用していない</li>
        <li>ステージ構成・アイテムの挙動・物理の実装はすべて独自に設計したもの</li>
      </ul>
      <p>原作は Windows 95/98/Me/XP 向けで、現在は入手も実行も困難。挙動を参照できないため、再現ではなく着想元として扱っている。</p>

      <h2>素材</h2>
      <dl class="doc-list">
        <dt>主人公（トラ）の歩行</dt>
        <dd>Google Gemini で生成した画像を <code>tools/extract-frames.py</code> で加工</dd>
        <dt>背景・地形・アイテム・鳥・エフェクト</dt>
        <dd>すべてコードによる手続き的描画。画像ファイルなし</dd>
        <dt>フォント</dt>
        <dd>環境の既定フォントのみ。同梱していない</dd>
        <dt>音</dt>
        <dd>未実装</dd>
      </dl>
      <p>生成画像の利用条件は Google Gemini の利用規約に従う。個人の非商用公開であることを前提としている。</p>

      <h2>ライセンス</h2>
      <p>LICENSE ファイルは置いていない。この場合、既定では著作権はすべて作者に留保され、第三者による複製・改変・再配布は許諾されない。</p>

      <p class="doc-foot">
        ソースコードと詳しい解説：
        <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${REPO_URL}</a>
      </p>
    </article>
  `;

  const back = document.createElement('button');
  back.textContent = 'タイトルへ';
  back.addEventListener('click', handlers.onBack);
  el.append(back);

  return el;
}

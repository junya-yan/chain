# 画像生成AIに渡す指示と、必要なデータ

## まず結論

画像生成AIは**コマ間の一貫性を保つのが非常に苦手**。「12コマの歩行スプライト
シートを作って」と頼むと、ほぼ必ず次のどちらかになる。

- スプライトシートの「ポスター」（タイトル文字・枠線・偽のHUDつき）
- コマごとに体格・向き・位置がずれた、animation にならない絵

なので **A案（1コマずつ個別に生成）を強く勧める**。B案は保険。

---

## A案（推奨）— ポーズごとに1枚ずつ生成する

シートを作らせない。**1回の生成につき1ポーズ、1枚の画像**。
こちらでシートに組み直すので、バラバラのファイルのままで構わない。

### 全ポーズ共通の指示（毎回つける）

```
A single side-view character, facing right, full body, centered.
Flat solid magenta background (#FF00FF), nothing else in the image.
No text, no frame, no border, no UI, no HUD, no ground, no shadow, no grid.
The character must fill the same proportion of the canvas in every image.
Square canvas, 512x512.
```

**背景は「透明」ではなく「べた塗りのマゼンタ #FF00FF」と指定すること。**
多くの生成AIは本物の透過PNGを出せず、市松模様を「絵として」描いてしまう
（今回それが起きた）。単色べた塗りなら、こちらで確実に切り抜ける。
キャラの服にマゼンタを使わないことだけ注意。

### 必要なポーズ

**トラ（tiger）** — 最低限 `walk` の6枚があれば動く。

| クリップ | 枚数 | 各コマの指示 |
| --- | --- | --- |
| `walk` | 6 | 歩行1周期を6等分。下記の各ポーズを個別に生成 |
| `climb` | 4 | ロープにしがみつき、**正面向き**、手足を交互に上げる |
| `fall` | 1 | 落下中。手足を広げ、驚いた顔 |
| `idle` | 2 | 立ち止まり。呼吸で少し上下するだけ |

`walk` 6コマの内訳（これを1枚ずつ生成する）:

1. 右脚を前に大きく踏み出し、左腕が前（接地の瞬間）
2. 右脚に体重が乗り、左脚が地面を離れる。体が最も低い
3. 両脚が揃い、体が最も高い（すれ違い）
4. 左脚を前に大きく踏み出し、右腕が前（1の左右反転の動き）
5. 左脚に体重が乗り、右脚が地面を離れる。体が最も低い
6. 両脚が揃い、体が最も高い

**鳥（bird）** — 無くても手続き的描画で動く。余裕があれば。

| クリップ | 枚数 | 内容 |
| --- | --- | --- |
| `perched` | 2 | 枝にとまって、わずかに動く |
| `startled` | 2 | 驚いて羽を広げる |
| `flying` | 4 | 羽ばたき1周期（上・中・下・中） |

### 絶対に守ってほしい3点

1. **全コマで足の裏の高さ（ベースライン）を揃える。** ずれると歩くたびに
   キャラが上下にガタつく。生成後にこちらで揃えることもできる。
2. **全コマでキャラの背丈を揃える。** これが一番ずれやすい。
3. **右向きで統一。** 左向きはエンジンが反転して作る。両方作ると不整合になる。

---

## B案 — どうしてもシートで作る場合

```
A sprite sheet on a single image, 6 columns x 1 row, 6 frames total.
Each frame is exactly 256x256 pixels, laid out in a perfectly uniform grid
with no gaps and no margins.
Flat solid magenta background (#FF00FF) filling every frame.
No text, no title, no labels, no borders between frames, no UI, no HUD,
no ground line, no checkerboard pattern, no drop shadow.
The same character in every frame, identical size and identical foot height,
side view facing right, only the limb positions change.
```

「no checkerboard pattern」「no text」「no border」は必ず入れる。
今回のポスター化はこれが無かったのが原因。

---

## こちらに渡してもらうもの

画像ファイルだけでよい。以下はこちらで測って設定する。

- 切り抜き（マゼンタ → 透過）
- ベースライン合わせ
- シートへの組み直し
- `manifest.json` の作成（frameW / frameH / anchor / scale / clips）

ファイル名は `walk-1.png` … `walk-6.png`、`climb-1.png` … のように
クリップ名と連番にしておいてもらえると、そのまま自動で組める。

---

## 補足：1枚だけでも動かせる

「歩行6コマを一貫した絵柄で」がどうしても揃わない場合、
**立ちポーズ1枚**だけ用意してもらえれば、こちらで頭・胴・腕・脚・しっぽに
切り分けて、変形で歩かせることができる（スケルタルアニメーション）。

- 利点: コマ間のブレが原理的に起きない。移動距離への同期も完璧。
  絵は1枚でよいので、AIの一貫性の弱点を完全に回避できる。
- 欠点: 手描きのコマ割りほどの表情は出ない。

この場合に必要な指示:

```
A single side-view character standing in a neutral T-pose-like stance,
facing right, arms and legs slightly apart and clearly separated from
the body so each limb can be cut out individually.
Flat solid magenta background (#FF00FF). No text, no frame, no ground,
no shadow. Square canvas, 512x512.
```

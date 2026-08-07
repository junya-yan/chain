"""AI が出力した「スプライトシート風の絵」から、使えるスプライトシートを作る。

やっていること:
 1. 4x4 のセルに切り分ける（コマ番号の重複を除いて 12 コマを選ぶ）
 2. 焼き込まれた背景（空のグラデーションと地面）を、外周からの塗りつぶしで抜く
    - 隣接ピクセルとの色差で伝播させるので、なめらかなグラデーションを追える
    - キャラの濃い輪郭線が自然な堰になって、塗りつぶしが内側へ漏れない
 3. キャラの外接矩形を測り、背丈と足元の高さを全コマで揃える
    （生成AIはここが揃わない。揃えないと歩くたびにガタつく）
 4. 横一列のシートに組み直して PNG (RGBA) で書き出す

    python3 tools/extract-frames.py
"""

import sys
from collections import deque

sys.path.insert(0, "tools")
from pnglib import decode, encode  # noqa: E402

SRC = "art-source/IMG_5327.PNG"
OUT = "public/sprites/lion.png"

# 実測したセル境界（tools で行・列の暗い帯を検出して求めた）
ROWS = [(13, 236), (265, 486), (514, 737), (767, 990)]
COLS = [(13, 262), (266, 515), (519, 768), (772, 1021)]

# ラベルのコマ番号は 1,2,3,4 / 4,5,6,7 / 7,8,9,10 / 10,11,11,12 と重複している。
# 重複を除いて 12 コマぶんの (row, col) を選ぶ。
CELLS = [
    (0, 0), (0, 1), (0, 2), (0, 3),
    (1, 1), (1, 2), (1, 3),
    (2, 1), (2, 2), (2, 3),
    (3, 1), (3, 3),
]

# 塗りつぶしの許容色差。大きいほどよく抜けるが、キャラを削るリスクが上がる。
TOLERANCE = 52
# 出力する 1 コマのサイズ。
FRAME_W, FRAME_H = 160, 160
# コマ内でキャラの背丈をどれだけにするか（足元合わせの基準）。
TARGET_H = 128
# 足元を置く y 位置。
BASELINE = 146


def crop(px, r, c):
    y0, y1 = ROWS[r]
    x0, x1 = COLS[c]
    return [[px[y][x] for x in range(x0, x1 + 1)] for y in range(y0, y1 + 1)]


def dist(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def remove_background(cell):
    """外周から色差で塗りつぶし、届いた範囲を透明にする。"""
    h = len(cell)
    w = len(cell[0])
    bg = [[False] * w for _ in range(h)]
    q = deque()

    for x in range(w):
        for y in (0, h - 1):
            if not bg[y][x]:
                bg[y][x] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not bg[y][x]:
                bg[y][x] = True
                q.append((x, y))

    while q:
        x, y = q.popleft()
        here = cell[y][x]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not bg[ny][nx]:
                if dist(here, cell[ny][nx]) <= TOLERANCE:
                    bg[ny][nx] = True
                    q.append((nx, ny))

    out = []
    for y in range(h):
        row = []
        for x in range(w):
            p = cell[y][x]
            row.append((p[0], p[1], p[2], 0 if bg[y][x] else 255))
        out.append(row)
    return out


def keep_largest_component(rgba):
    """最大の連結成分だけ残す。

    塗りつぶしだけでは地面の岩やひび割れが島として残る。キャラは 1 つながりに
    描かれているので、最大の塊＝キャラ。これで瓦礫がまとめて消える。
    """
    h = len(rgba)
    w = len(rgba[0])
    label = [[0] * w for _ in range(h)]
    best_id = 0
    best_size = 0
    current = 0

    for sy in range(h):
        for sx in range(w):
            if not rgba[sy][sx][3] or label[sy][sx]:
                continue
            current += 1
            size = 0
            q = deque([(sx, sy)])
            label[sy][sx] = current
            while q:
                x, y = q.popleft()
                size += 1
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and rgba[ny][nx][3] and not label[ny][nx]:
                        label[ny][nx] = current
                        q.append((nx, ny))
            if size > best_size:
                best_size = size
                best_id = current

    for y in range(h):
        for x in range(w):
            if label[y][x] != best_id:
                p = rgba[y][x]
                rgba[y][x] = (p[0], p[1], p[2], 0)
    return best_size


def bbox(rgba):
    h = len(rgba)
    w = len(rgba[0])
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if rgba[y][x][3]:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    if x1 < 0:
        return None
    return x0, y0, x1, y1


def sample(rgba, fx, fy):
    """最近傍サンプリング。"""
    h = len(rgba)
    w = len(rgba[0])
    x = int(fx)
    y = int(fy)
    if x < 0 or y < 0 or x >= w or y >= h:
        return (0, 0, 0, 0)
    return rgba[y][x]


def main():
    w, h, px = decode(SRC)
    print("読み込み: %dx%d" % (w, h))

    frames = []
    for i, (r, c) in enumerate(CELLS):
        cell = crop(px, r, c)
        rgba = remove_background(cell)
        blob = keep_largest_component(rgba)
        box = bbox(rgba)
        if box is None:
            print("  コマ %2d: 中身が空。スキップ" % (i + 1))
            continue
        x0, y0, x1, y1 = box
        print(
            "  コマ %2d: キャラ %dx%d (%d px)  足元 y=%d"
            % (i + 1, x1 - x0 + 1, y1 - y0 + 1, blob, y1)
        )
        frames.append((rgba, box))

    # 背丈と足元を全コマで揃える。ここを揃えないと歩行がガタつく。
    canvas = [[(0, 0, 0, 0)] * (FRAME_W * len(frames)) for _ in range(FRAME_H)]
    for idx, (rgba, (x0, y0, x1, y1)) in enumerate(frames):
        src_h = y1 - y0 + 1
        src_w = x1 - x0 + 1
        scale = TARGET_H / src_h
        dst_w = max(1, int(src_w * scale))
        dst_h = max(1, int(src_h * scale))
        ox = idx * FRAME_W + (FRAME_W - dst_w) // 2
        oy = BASELINE - dst_h
        for dy in range(dst_h):
            ty = oy + dy
            if ty < 0 or ty >= FRAME_H:
                continue
            for dx in range(dst_w):
                tx = ox + dx
                if tx < idx * FRAME_W or tx >= (idx + 1) * FRAME_W:
                    continue
                p = sample(rgba, x0 + dx / scale, y0 + dy / scale)
                if p[3]:
                    canvas[ty][tx] = p

    size = encode(OUT, canvas)
    print("書き出し: %s  %dx%d  %d コマ  %d bytes" % (OUT, FRAME_W * len(frames), FRAME_H, len(frames), size))
    print("frameW=%d frameH=%d anchorX=%d anchorY=%d" % (FRAME_W, FRAME_H, FRAME_W // 2, BASELINE))


main()

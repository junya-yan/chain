"""最小限の PNG デコーダ／エンコーダ（PIL 無しで動かすため）。

このプロジェクトのアセット加工に必要な範囲だけを実装している。
- デコード: bitdepth 8、colortype 2 (RGB) と 6 (RGBA)、インターレース無し
- エンコード: colortype 6 (RGBA) のみ
"""

import struct
import zlib


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode(path):
    """PNG を読み、(width, height, pixels) を返す。

    pixels は行ごとの list で、各要素は (r, g, b, a) のタプル。
    """
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG ではない: %s" % path)

    pos = 8
    idat = bytearray()
    width = height = bitdepth = colortype = None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        tag = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height, bitdepth, colortype, comp, filt, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            if bitdepth != 8:
                raise ValueError("bitdepth 8 のみ対応: %d" % bitdepth)
            if colortype not in (2, 6):
                raise ValueError("colortype 2/6 のみ対応: %d" % colortype)
            if interlace:
                raise ValueError("インターレースは非対応")
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break

    channels = 3 if colortype == 2 else 4
    raw = zlib.decompress(bytes(idat))
    stride = width * channels

    out = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                upleft = prev[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 0xFF
        elif f != 0:
            raise ValueError("未知のフィルタ: %d" % f)

        row = []
        if channels == 3:
            for x in range(width):
                o = x * 3
                row.append((line[o], line[o + 1], line[o + 2], 255))
        else:
            for x in range(width):
                o = x * 4
                row.append((line[o], line[o + 1], line[o + 2], line[o + 3]))
        out.append(row)
        prev = line

    return width, height, out


def encode(path, pixels):
    """RGBA の 2 次元 list を PNG (colortype 6) として書き出す。"""
    height = len(pixels)
    width = len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for p in row:
            raw += bytes((p[0], p[1], p[2], p[3]))

    def chunk(tag, body):
        c = tag + body
        return struct.pack(">I", len(body)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    open(path, "wb").write(png)
    return len(png)

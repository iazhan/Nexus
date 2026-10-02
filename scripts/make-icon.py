#!/usr/bin/env python3
"""生成 Nexus 的应用图标：256x256 PNG + 多尺寸 ICO。纯标准库，不引第三方依赖。

用法：`python scripts/make-icon.py`（重跑会覆盖，结果是确定的）。

为什么手写而不是装 Pillow：这是**一次性**工具，为它拉一个图像库进开发环境不值当。
图形本身是几何的（圆角矩形 + 字母 N），逐像素判定就够了，不需要光栅器。

**每个尺寸独立渲染，不是把 256 缩下去。** 几何量全是 `size` 的比例，所以同一份
定义在 16 上照样成立；而缩放会先把抗锯齿过的边缘糊掉，再叠一次重采样 —— 16x16 的
字母 N 会糊成一团。代价是每加一档就多一遍渲染，这个图形总共有 7 档，无所谓。

ICO 里 **256 存 PNG、其余存 BMP(DIB)**。PNG 条目是 Vista 才有的，小尺寸走 BMP
兼容面最宽；而 256 存 BMP 要 256KB，一个图标文件里占掉大半没必要。

产物落在 `apps/desktop/resources/` —— 不落 `build/`，那个目录被 .gitignore 当作构建产物
忽略了，而图标是**源文件**：要进版本库，换台机器打包也得有。这个脚本同理留在 `scripts/`
而不是 `tmp/` —— 图标是二进制，没有脚本就成了不可复现的魔法文件。
"""

import struct
import zlib
from pathlib import Path

# 逐档渲染的目标边长。16/32/48 是任务栏与资源管理器的实际取值，
# 64/128 供大图标视图，256 供「超大图标」与安装包。
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)

# PNG 只给最大那档；其余走 BMP。
PNG_SIZE = 256

# 超采样倍数，用来做边缘抗锯齿。每档都按 size * SS 判定再平均。
SS = 4

BG_TOP = (0x2B, 0x3A, 0x55)
BG_BOTTOM = (0x17, 0x1D, 0x2B)
FG = (0xF2, 0xF5, 0xFA)


def inside_rounded(x, y, size, radius):
    half = size / 2.0
    dx = abs(x - half)
    dy = abs(y - half)
    if dx > half or dy > half:
        return False
    inner = half - radius
    if dx <= inner or dy <= inner:
        return True
    return (dx - inner) ** 2 + (dy - inner) ** 2 <= radius ** 2


def inside_n(x, y, size):
    """字母 N：左右两根竖条 + 一条从左上内角到右下内角的斜线。"""
    x0 = 0.300 * size
    x1 = 0.700 * size
    y0 = 0.270 * size
    y1 = 0.730 * size
    w = 0.084 * size
    if not (y0 <= y <= y1):
        return False
    if x0 <= x <= x0 + w or x1 - w <= x <= x1:
        return True
    t = (y - y0) / (y1 - y0)
    xc = (x0 + w / 2.0) + t * ((x1 - w / 2.0) - (x0 + w / 2.0))
    return abs(x - xc) <= w / 2.0


def render_rgba(size):
    """渲染一档，返回 `size * size` 个 `(r, g, b, a)`（逐行、自上而下）。"""
    n = size * SS
    radius = 0.225 * n
    pixels = []
    for py in range(size):
        for px in range(size):
            r = g = b = 0.0
            covered = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px * SS + sx + 0.5
                    y = py * SS + sy + 0.5
                    if not inside_rounded(x, y, n, radius):
                        continue
                    covered += 1
                    if inside_n(x, y, n):
                        cr, cg, cb = FG
                    else:
                        t = y / n
                        cr = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t
                        cg = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t
                        cb = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t
                    r += cr
                    g += cg
                    b += cb
            if covered == 0:
                pixels.append((0, 0, 0, 0))
            else:
                # 颜色除以**被覆盖的样本数**而不是总样本数：除以总数会把边缘颜色往黑里拉，
                # 圆角处会出现一圈暗边。
                pixels.append(
                    (
                        int(round(r / covered)),
                        int(round(g / covered)),
                        int(round(b / covered)),
                        int(round(covered * 255.0 / (SS * SS))),
                    )
                )
    return pixels


def png_chunk(tag, data):
    return (
        struct.pack('>I', len(data))
        + tag
        + data
        + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def encode_png(pixels, size):
    raw = bytearray()
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            raw += bytes(pixels[y * size + x])
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', ihdr)
        + png_chunk(b'IDAT', zlib.compress(bytes(raw), 9))
        + png_chunk(b'IEND', b'')
    )


def encode_dib(pixels, size):
    """32bpp 的 BITMAPINFOHEADER + 自下而上的 BGRA + 1bpp AND 掩码。"""
    header = struct.pack(
        '<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0
    )

    color = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            r, g, b, a = pixels[y * size + x]
            color += bytes((b, g, r, a))

    # AND 掩码：每行按 4 字节对齐，1 位表示「透明」。32bpp 下 Windows 优先看 alpha，
    # 这里同步一份是为了让仍然读掩码的老渲染路径也拿到正确的形状。
    stride = ((size + 31) // 32) * 4
    mask = bytearray()
    for y in range(size - 1, -1, -1):
        row = bytearray(stride)
        for x in range(size):
            if pixels[y * size + x][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row

    return header + bytes(color) + bytes(mask)


def encode_ico(entries):
    """`entries` 是 `(size, payload)`，按顺序写进 ICO。宽高字段写 0 ＝ 256。"""
    header = struct.pack('<HHH', 0, 1, len(entries))
    directory = bytearray()
    offset = 6 + 16 * len(entries)
    for size, payload in entries:
        dim = 0 if size >= 256 else size
        directory += struct.pack(
            '<BBBBHHII', dim, dim, 0, 0, 1, 32, len(payload), offset
        )
        offset += len(payload)
    return header + bytes(directory) + b''.join(payload for _, payload in entries)


def main():
    out_dir = Path(__file__).resolve().parents[1] / 'apps' / 'desktop' / 'resources'
    out_dir.mkdir(parents=True, exist_ok=True)

    png_bytes = None
    entries = []
    for size in ICON_SIZES:
        pixels = render_rgba(size)
        if size == PNG_SIZE:
            payload = encode_png(pixels, size)
            png_bytes = payload
        else:
            payload = encode_dib(pixels, size)
        entries.append((size, payload))

    if png_bytes is None:
        raise SystemExit(f'PNG_SIZE={PNG_SIZE} 不在 ICON_SIZES 里，icon.png 会没有来源')

    (out_dir / 'icon.png').write_bytes(png_bytes)
    (out_dir / 'icon.ico').write_bytes(encode_ico(entries))

    for name in ('icon.png', 'icon.ico'):
        print(f'{name}: {(out_dir / name).stat().st_size} bytes')
    print(f'ICO 档位: {", ".join(str(size) for size in ICON_SIZES)}')


if __name__ == '__main__':
    main()

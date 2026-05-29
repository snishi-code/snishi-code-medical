"""PWA アイコン生成スクリプト

`scripts/icon-source.png` (透明背景の青い円 + 白いロゴ) をそのまま使い、
白い正方形キャンバスの中央に Chrome アイコンのような余白で配置する。

  - ソース画像の形は一切いじらない (リサイズと中央配置のみ)
  - 本番版: ソースの青をそのまま使用
  - テスト版: 青い部分だけを灰 (#475569) に置換、白ロゴはそのまま
  - 192 / 512 / 180 px を `public/icons/` に保存
  - 透明部分は白で埋める (Chrome の PWA maskable icon 要件を満たす)

依存: Pillow (`pip install Pillow`)
"""
import os
from PIL import Image

SRC = os.path.join(os.path.dirname(__file__), "icon-source.png")
OUT_DIR = "public/icons"

# ソース画像内の青 (実測: 4, 89, 196 付近の純度の高い青)
SOURCE_BLUE = (4, 89, 196)
# 出力色 (アプリ内で使っているのと同じコード)
SLATE_TARGET = (71, 85, 105)  # #475569 (テスト)

# レイアウト: 白い squircle (ランチャーのマスク後の見た目) の中央に色付き円。
# Chrome アイコンと同じ比率: 円直径は正方形辺の 68% (各辺 16% 程度の白マージン)。
# manifest を purpose: "any maskable" にしてあるのでランチャーが正方形に
# マスクを当て、白の角は切り落とされて Chrome 風の「白いカード + 色円」になる。
REF_SIDE = 1024
CIRCLE_RATIO = 0.68

SIZES = [
    (192, "icon-192"),
    (512, "icon-512"),
    (180, "apple-touch-icon"),
]


def recolor_blue_to(src, target):
    """ソースの青を target 色に置換。白いロゴは変更しない。
    ソースの青→白の直線軸にピクセルを射影し、t=0 で target、t=1 で白に再合成。
    AA エッジ (青と白のグラデ) も滑らかに追随する。透明ピクセルはそのまま。"""
    sb_r, sb_g, sb_b = SOURCE_BLUE
    vr, vg, vb = 255 - sb_r, 255 - sb_g, 255 - sb_b
    vv = vr * vr + vg * vg + vb * vb
    tr, tg, tb = target

    out = Image.new("RGBA", src.size)
    sp = src.load()
    op = out.load()
    for y in range(src.height):
        for x in range(src.width):
            r, g, b, a = sp[x, y]
            if a == 0:
                op[x, y] = (0, 0, 0, 0)
                continue
            # 青→白軸での射影位置
            ur, ug, ub = r - sb_r, g - sb_g, b - sb_b
            t = (ur * vr + ug * vg + ub * vb) / vv if vv > 0 else 0.0
            t = max(0.0, min(1.0, t))
            op[x, y] = (
                round((1 - t) * tr + t * 255),
                round((1 - t) * tg + t * 255),
                round((1 - t) * tb + t * 255),
                a,
            )
    return out


def compose_onto_white_square(src):
    """src を白い正方形キャンバスの中央に CIRCLE_RATIO 比で配置。
    Chrome アイコン風: 白いカード地に色付き円を載せる。
    purpose: any maskable で manifest に出してあるので、ランチャー側で
    squircle にマスクされ、白い角は切り落とされて Chrome 風の見た目になる。"""
    bbox = src.getbbox()
    if bbox is None:
        raise RuntimeError("source is fully transparent")
    cropped = src.crop(bbox)
    cw, ch = cropped.size
    target_max = int(REF_SIDE * CIRCLE_RATIO)
    scale = target_max / max(cw, ch)
    new_w, new_h = max(1, round(cw * scale)), max(1, round(ch * scale))
    scaled = cropped.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (REF_SIDE, REF_SIDE), (255, 255, 255, 255))
    paste_x = (REF_SIDE - new_w) // 2
    paste_y = (REF_SIDE - new_h) // 2
    canvas.paste(scaled, (paste_x, paste_y), scaled)
    return canvas


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    src = Image.open(SRC).convert("RGBA")

    # 本番: ソースの青をそのまま白いキャンバス中央に
    prod_canvas = compose_onto_white_square(src)
    # テスト: 青→灰に置換して白いキャンバス中央に
    test_canvas = compose_onto_white_square(recolor_blue_to(src, SLATE_TARGET))

    variants = [("", prod_canvas), ("-test", test_canvas)]
    for suffix, canvas in variants:
        for size, base in SIZES:
            resized = canvas.resize((size, size), Image.LANCZOS)
            path = f"{OUT_DIR}/{base}{suffix}.png"
            resized.save(path, optimize=True)
            print(f"  saved {path} ({size}x{size})")


if __name__ == "__main__":
    main()

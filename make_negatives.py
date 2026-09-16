"""
Negative (control) masks for Illusion Diffusion / ControlNet QR-monster.
White bold rounded text on black. Each variant gets random:
  - mixed bubbly fonts per letter (CherryBomb / Chewy / Fredoka / ...)
  - per-letter size / rotation / y-offset / spacing jitter
  - global arc curvature + rotation + position jitter (central safe zone)
Usage:
  python3 make_negatives.py --words AHOI MIA JONAS --variants 3 --outdir ./negatives [--mix-fonts]
Then upload a mask to HF Space AP123/IllusionDiffusion as Input Illusion.
"""
import os, random
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

_HERE = os.path.dirname(os.path.abspath(__file__))
FONT_CANDIDATES = [
    os.path.join(_HERE, "fonts", "CherryBomb.ttf"),          # closest to liquid-bubble reference
    os.path.join(_HERE, "fonts", "Chewy.ttf"),               # wobbly alternative
    os.path.join(_HERE, "fonts", "Fredoka-Bold.ttf"),
    os.path.join(_HERE, "fonts", "Baloo2-ExtraBold.ttf"),    # round + wavy
    os.path.join(_HERE, "fonts", "Shrikhand.ttf"),
    os.path.join(_HERE, "fonts", "Bubblegum.ttf"),
    os.path.join(_HERE, "fonts", "Nunito-Black.ttf"),
    "/usr/share/fonts/truetype/lato/Lato-Black.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_POOL = [p for p in FONT_CANDIDATES if os.path.exists(p)]
FONT_PATH = FONT_POOL[0] if FONT_POOL else None
# round-only mix, matching the bubble reference (no sharp/italic/thin faces)
ROUND_POOL = [
    p for p in [
        os.path.join(_HERE, "fonts", "CherryBomb.ttf"),
        os.path.join(_HERE, "fonts", "Chewy.ttf"),
        os.path.join(_HERE, "fonts", "Fredoka-Bold.ttf"),
        os.path.join(_HERE, "fonts", "Baloo2-ExtraBold.ttf"),
    ] if os.path.exists(p)
]

def render_word_layer(word, layer_w=1500, layer_h=600, seed=0, mix_fonts=True):
    """Render each letter separately with its own font/size/rotation/offset
    so letters differ (wavy baseline, varied spacing)."""
    rng = random.Random(seed)
    word = word.upper()
    base = int(layer_h * 0.46)
    # per-letter params first (so we can measure total width)
    params = []
    for ch in word:
        params.append({
            "size": int(base * rng.uniform(0.86, 1.14)),
            "rot": rng.uniform(-13, 13),
            "dy": rng.uniform(-28, 28),
            "wstretch": rng.uniform(0.92, 1.12),
            "tracking": rng.uniform(4, 36),  # varied gaps between letters, never touching
            "font": rng.choice(ROUND_POOL or FONT_POOL) if mix_fonts else FONT_PATH,
        })
    # render letters
    layer = Image.new("L", (layer_w, layer_h), 0)
    # measure total width
    widths = []
    for ch, p in zip(word, params):
        font = ImageFont.truetype(p["font"], p["size"])
        bbox = font.getbbox(ch)
        widths.append(int((bbox[2] - bbox[0]) * p["wstretch"]))
    total_w = sum(widths) + sum(p["tracking"] for p in params[1:])
    x = (layer_w - total_w) // 2
    baseline = layer_h // 2 + int(rng.uniform(-20, 20))
    wave_amp = rng.uniform(8, 30)
    wave_freq = rng.uniform(0.8, 1.6)
    wave_phase = rng.uniform(0, 6.28)
    for i, (ch, p) in enumerate(zip(word, params)):
        font = ImageFont.truetype(p["font"], p["size"])
        # letter tile with padding for rotation
        tile = Image.new("L", (p["size"] * 2, p["size"] * 2), 0)
        td = ImageDraw.Draw(tile)
        td.text((tile.width // 2, tile.height // 2), ch, fill=255, font=font,
                anchor="mm", stroke_width=max(3, p["size"] // 28), stroke_fill=255)
        if abs(p["wstretch"] - 1.0) > 0.02:
            tile = tile.resize((int(tile.width * p["wstretch"]), tile.height), Image.BICUBIC)
        tile = tile.rotate(p["rot"], resample=Image.BICUBIC, expand=True, fillcolor=0)
        # wavy baseline: sine over letter index + individual jitter
        y = baseline + int(wave_amp * np.sin(i / max(1, len(word) - 1) * np.pi * wave_freq + wave_phase)) + int(p["dy"] * 0.5)
        layer.paste(tile, (int(x + (widths[i] - tile.width) // 2), int(y - tile.height // 2)), tile)
        x += widths[i] + (p["tracking"] if i + 1 < len(params) else 0)
    # round the corners: max filter fattens + blur + re-threshold
    layer = layer.filter(ImageFilter.MaxFilter(5))
    layer = layer.filter(ImageFilter.GaussianBlur(2.0))
    arr = np.asarray(layer)
    arr = (arr > 110).astype(np.uint8) * 255
    layer = Image.fromarray(arr, mode="L")
    layer = layer.filter(ImageFilter.GaussianBlur(1.0))
    # autocrop vertical whitespace to keep word compact
    bbox = layer.getbbox()
    if bbox:
        layer = layer.crop(bbox)
    return layer

def apply_curve(layer, bend=0.0, wave=0.0, phase=0.0):
    """Vertical shift per column: parabola (arc) + sine S-curve."""
    arr = np.asarray(layer)
    h, w = arr.shape
    xs = np.arange(w)
    cx = w / 2
    shift = bend * ((xs - cx) / (w / 2)) ** 2  # px at edges
    shift += wave * np.sin(xs / w * 2 * np.pi + phase)
    out = np.zeros_like(arr)
    for x in range(w):
        s = int(round(shift[x]))
        col = arr[:, x]
        if s > 0:
            out[s:, x] = col[:h - s] if s < h else 0
        elif s < 0:
            out[:h + s, x] = col[-s:] if -s < h else 0
        else:
            out[:, x] = col
    return Image.fromarray(out, mode="L")

def make_negative(word, W=1024, H=1024, seed=0, mix_fonts=True):
    rng = random.Random(seed)
    layer = render_word_layer(word, seed=seed, mix_fonts=mix_fonts)
    layer = ImageOps.expand(layer, border=(0, 140), fill=0)  # headroom for curve shifts
    bend = rng.uniform(-80, 80)          # arc smile/frown in px
    wave = rng.uniform(-16, 16)          # S-curve amount
    phase = rng.uniform(0, 6.28)
    layer = apply_curve(layer, bend, wave, phase)
    angle = rng.uniform(-18, 18)
    layer = layer.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=0)
    # keep full word inside canvas with margin (long words shrink + tighter jitter)
    MARGIN = 50
    max_w, max_h = W - 2 * MARGIN, int(H * 0.62)
    if layer.width > max_w or layer.height > max_h:
        s = min(max_w / layer.width, max_h / layer.height)
        layer = layer.resize((int(layer.width * s), int(layer.height * s)), Image.LANCZOS)
    # paste at jittered center inside safe zone (keep away from edges for illusion)
    canvas = Image.new("L", (W, H), 0)
    hw, hh = layer.width // 2, layer.height // 2
    cx = int(rng.uniform(max(hw + MARGIN, W * 0.38), min(W - hw - MARGIN, W * 0.62)))
    cy = int(rng.uniform(max(hh + MARGIN, H * 0.40), min(H - hh - MARGIN, H * 0.60)))
    canvas.paste(layer, (cx - hw, cy - hh), layer)
    return canvas

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--words", nargs="+", default=["AHOI"])
    ap.add_argument("--variants", type=int, default=3)
    ap.add_argument("--outdir", default="./negatives")
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--mix-fonts", dest="mix_fonts", action="store_true", default=True)
    ap.add_argument("--no-mix-fonts", dest="mix_fonts", action="store_false")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    for wi, w in enumerate(args.words):
        for v in range(args.variants):
            seed = 1000 + wi * 100 + v * 17
            neg = make_negative(w, W=args.size, H=args.size, seed=seed, mix_fonts=args.mix_fonts)
            path = f"{args.outdir}/{w.lower()}_neg_v{v}.png"
            neg.save(path)
            print(f"saved {path}")

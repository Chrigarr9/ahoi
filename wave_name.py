"""
Hidden-name abstract waves generator for jerseys.
Principle: topographic camouflage.
  h(x,y) = wavy base + lift * text_mask
Contours of h wrap around the letters -> waves bend to form the name.
  lift ~2.0-2.5 + blur ~10-14 = readable but hidden (good for jerseys)
  lift integer = interior in phase = more hidden
  lift x.5 = interior out of phase = more visible
  larger blur = smoother, more hidden / smaller blur = sharper outline
Batch: python3 wave_name.py --words AHOI MIA JONAS --outdir ./prints
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
import zlib

def tile_noise(W, H, res, rng):
    rnd = rng.random((res, res)).astype(np.float32)
    img = Image.fromarray((rnd*255).astype(np.uint8), mode='L')
    img = img.resize((W, H), Image.BICUBIC)
    # extra blur kills grid creases from resize
    img = img.filter(ImageFilter.GaussianBlur(W/max(8, res*2)))
    return np.asarray(img).astype(np.float32)/255.0

def fbm(W, H, base_res=6, octaves=4, seed=0):
    rng = np.random.default_rng(seed)
    acc = np.zeros((H, W), np.float32)
    amp = 1.0
    total = 0.0
    res = base_res
    for _ in range(octaves):
        acc += amp * tile_noise(W, H, res, rng)
        total += amp
        amp *= 0.5
        res *= 2
    return acc/total  # 0..1

def text_mask(W, H, text, blur=9):
    img = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(img)
    # find bold font
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/lato/Lato-Black.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]
    font_path = next((p for p in candidates if os.path.exists(p)), None)
    # auto-fit
    size = int(H*0.42)
    while size > 10:
        try:
            font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        except Exception:
            font = ImageFont.load_default()
            break
        bbox = d.textbbox((0,0), text.upper(), font=font)
        tw = bbox[2]-bbox[0]
        if tw < W*0.80:
            break
        size -= 8
    font = ImageFont.truetype(font_path, size) if font_path else font
    d.text((W//2, H//2), text.upper(), fill=255, font=font, anchor="mm")
    if blur>0:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(img).astype(np.float32)/255.0

def generate(text, out_path, W=1024, H=1024, seed=7,
             base_bands=24, lift=2.5, warp=0.08, wave_amp=1.0, blur=12):
    rng_seed = seed + zlib.crc32(text.upper().encode()) % 100000
    # smooth large-scale flow only -> long horizontal waves like reference
    n1 = fbm(W, H, base_res=4, octaves=3, seed=rng_seed)
    n2 = fbm(W, H, base_res=4, octaves=3, seed=rng_seed+101)
    detail = fbm(W, H, base_res=12, octaves=2, seed=rng_seed+202)

    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    xn = xs / W
    yn = ys / H

    Xw = xn + (n1-0.5)*warp
    Yw = yn + (n2-0.5)*warp*0.6

    # base wavy plane: dominated by Y -> horizontal stripes
    base = (Yw * base_bands
            + wave_amp*np.sin(Xw*np.pi*2*2.0 + n1*5.0)
            + 0.7*np.sin(Xw*np.pi*2*4.0 + 1.7*n2)
            + (detail-0.5)*0.6)

    mask = text_mask(W, H, text, blur=blur if blur else max(16, W//32))
    m = np.clip(mask, 0, 1)
    if m.max() > 0:
        m = m / m.max()  # normalize so lift is exact -> integer lift = hidden
    m = m*m*(3-2*m)

    h = base + m*lift

    frac = h - np.floor(h)  # 0..1 position inside band
    t = 0.5 + 0.5*np.sin(h*np.pi*2)  # smooth 0..1 for shading
    t = np.clip(t, 0, 1)

    # palette (sampled from your jersey: deep blue / mid / light / cream)
    deep  = np.array([62, 108, 145], np.float32)
    mid   = np.array([122, 172, 203], np.float32)
    light = np.array([178, 208, 230], np.float32)
    cream = np.array([244, 237, 221], np.float32)

    # thinner cream bands like reference (~35% of period)
    a = np.clip(t/0.75, 0, 1)
    b = np.clip((t-0.62)/0.30, 0, 1)
    b = b*b*(3-2*b)
    base_col = deep[None,None,:]*(1-a[...,None]) + mid[None,None,:]*a[...,None]
    # lighten mids a touch
    base_col = base_col*(1-0.25*a[...,None]) + light[None,None,:]*(0.25*a[...,None])
    col = base_col*(1-b[...,None]) + cream[None,None,:]*b[...,None]

    # soft hand-painted edge: slight darkening on one side only, no thin iso-lines
    edge_dark = np.clip(1-np.abs(frac-0.60)*6, 0, 1)*0.12
    col *= (1 - edge_dark[...,None])

    # emboss from gradient of h
    gy, gx = np.gradient(h)
    shade = (gx*0.5 + gy*0.8)
    shade = np.clip(shade/ (np.abs(shade).mean()*4+1e-6), -1, 1)
    col += shade[...,None]*9

    # paper grain
    col += (detail[...,None]-0.5)*10

    col = np.clip(col, 0, 255).astype(np.uint8)
    Image.fromarray(col).save(out_path)
    print(f"saved {out_path}  text={text!r} lift={lift}")

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--words", nargs="+", default=["AHOI"])
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--lift", type=float, default=6.0,
                    help="integer (e.g. 6) = well hidden, x.5 (e.g. 5.5) = more visible")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    for i, w in enumerate(args.words):
        generate(w, f"{args.outdir}/{w.lower()}_waves.png", seed=7+i*17, lift=args.lift)

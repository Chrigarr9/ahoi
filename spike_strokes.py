"""
Spike: hidden word as brush strokes following a flow field.
  letters = centerline paths -> bend an orientation field toward them
  -> evenly spaced streamlines (Jobard-Lefer) pack around the letters
  -> every streamline drawn as a tapered ribbon (PNG + SVG).
Run: python3 spike_strokes.py  -> spike_out/<variant>.png/.svg + sheet.png
"""
import math, os, random
from collections import deque
import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree

W, H = 800, 1000
SS = 3  # supersampling for PNG
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "spike_out")

PALETTES = {
    # bg, [(stroke colour, weight)], letter colour
    "sea":    ((88, 124, 160), [((238, 232, 214), .55), ((168, 192, 210), .3), ((62, 94, 128), .15)], (238, 232, 214)),
    "sunset": ((36, 46, 80),   [((242, 162, 98), .45), ((226, 104, 88), .3), ((250, 224, 172), .25)], (242, 162, 98)),
    "ink":    ((244, 239, 227), [((28, 38, 64), .7), ((120, 130, 150), .3)], (28, 38, 64)),
    "mint":   ((226, 236, 228), [((38, 96, 96), .5), ((96, 164, 150), .3), ((210, 126, 92), .2)], (38, 96, 96)),
}
BOAT = {"sail": (240, 234, 218), "hull": (150, 100, 60)}


# ---------- geometry
def chaikin(pts, n=2):
    pts = np.asarray(pts, float)
    for _ in range(n):
        q = 0.75 * pts[:-1] + 0.25 * pts[1:]
        r = 0.25 * pts[:-1] + 0.75 * pts[1:]
        mid = np.empty((2 * len(q), 2)); mid[0::2] = q; mid[1::2] = r
        pts = np.vstack([pts[:1], mid, pts[-1:]])
    return pts

def resample(pts, step):
    pts = np.asarray(pts, float)
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    if s[-1] < 2 * step:
        return pts
    t = np.arange(0, s[-1], step)
    return np.column_stack([np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])])

def quad(p0, c, p1, n=40):
    t = np.linspace(0, 1, n)[:, None]
    p0, c, p1 = map(np.array, (p0, c, p1))
    return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * c + t ** 2 * p1


# ---------- glyphs: unit height, baseline y=1, x-height ~0.45
def glyph(ch, boat):
    if ch == "A" and boat:
        sail = [(0.30, -0.05), (0.10, 0.84), (0.64, 0.78)]
        hull = [(-0.10, 0.86), (0.82, 0.82), (0.62, 1.06), (0.05, 1.08)]
        return dict(strokes=[], dots=[], shapes=[(sail, "sail"), (hull, "hull")], adv=0.95)
    if ch == "A":
        return dict(strokes=[chaikin([(0, 1), (0.3, 0.02), (0.6, 1)], 3),
                             np.array([(0.12, 0.64), (0.5, 0.62)])], dots=[], shapes=[], adv=0.8)
    if ch == "H":
        arch = np.vstack([quad((0, 0.66), (0.26, 0.22), (0.5, 0.66)), [(0.5, 1.0)]])
        return dict(strokes=[np.array([(0, 0), (0, 1)]), chaikin(arch, 2)], dots=[], shapes=[], adv=0.75)
    if ch == "O":
        a = np.linspace(0, 2 * math.pi * 1.9, 220)
        r = np.linspace(0.27, 0.04, 220)
        return dict(strokes=[np.column_stack([0.3 + r * np.cos(a), 0.72 + r * np.sin(a)])],
                    dots=[], shapes=[], adv=0.72)
    if ch == "I":
        return dict(strokes=[np.array([(0.05, 0.52), (0.05, 1.0)])], dots=[(0.05, 0.3, 0.065)],
                    shapes=[], adv=0.35)
    raise ValueError(ch)

def layout(word, size, center, angle, boat, rng):
    gl = [glyph(c, boat) for c in word]
    total = sum(g["adv"] for g in gl) - 0.3
    ca, sa = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    def T(p, ox, dy):
        p = np.atleast_2d(np.asarray(p, float))
        x = (p[:, 0] + ox - total / 2) * size
        y = (p[:, 1] + dy - 0.5) * size
        return np.column_stack([center[0] + ca * x - sa * y, center[1] + sa * x + ca * y])
    strokes, dots, shapes, ox = [], [], [], 0.0
    for g in gl:
        dy = rng.uniform(-0.06, 0.06)
        strokes += [resample(T(s, ox, dy), 2) for s in g["strokes"]]
        dots += [(*T((x, y), ox, dy)[0], r * size) for x, y, r in g["dots"]]
        shapes += [(T(p, ox, dy), k) for p, k in g["shapes"]]
        ox += g["adv"]
    return strokes, dots, shapes


# ---------- orientation field (doubled angle -> sign-free, so spirals/verticals blend cleanly)
def to2(dx, dy):
    return dx * dx - dy * dy, 2 * dx * dy

def orientation_field(rng, st, strokes, shapes, sigma, g=4):
    gw, gh = W // g + 3, H // g + 3
    def noise(scale):
        n = gaussian_filter(rng.standard_normal((gh, gw)), scale / g, mode="wrap")
        return n / n.std()
    theta = math.radians(st["tilt"]) + st["amp"] * noise(st["scale"])
    v = np.stack([np.cos(2 * theta), np.sin(2 * theta)], -1)
    gy, gx = np.mgrid[0:gh, 0:gw] * g

    for _ in range(st.get("vortices", 0)):  # optional whirlpools
        cx, cy, R = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(60, 140)
        dx, dy = gx - cx, gy - cy
        d = np.hypot(dx, dy) + 1e-6
        t2 = np.stack(to2(-dy / d, dx / d), -1)
        w = np.exp(-(d / R) ** 2)[..., None]
        v = (1 - w) * v + w * t2

    guides = strokes + [resample(np.vstack([p, p[:1]]), 2) for p, _ in shapes]
    if guides:
        P = np.vstack(guides)
        Tn = np.vstack([np.gradient(s, axis=0) for s in guides])
        Tn /= np.linalg.norm(Tn, axis=1, keepdims=True) + 1e-9
        t2 = np.column_stack(to2(Tn[:, 0], Tn[:, 1]))
        d, idx = cKDTree(P).query(np.column_stack([gx.ravel(), gy.ravel()]))
        w = np.exp(-(d / sigma) ** 2).reshape(gh, gw, 1)
        v = (1 - w) * v + w * t2[idx].reshape(gh, gw, 2)
    return v[..., 0].tolist(), v[..., 1].tolist(), g


# ---------- evenly spaced streamlines
class Packer:
    def __init__(self, cell):
        self.cell, self.grid = cell, {}
    def add(self, pts, r):
        for x, y in pts:
            self.grid.setdefault((int(x // self.cell), int(y // self.cell)), []).append((x, y, r))
    def free(self, x, y, r, k):
        cx, cy = int(x // self.cell), int(y // self.cell)
        for i in range(cx - 2, cx + 3):
            for j in range(cy - 2, cy + 3):
                for px, py, pr in self.grid.get((i, j), ()):
                    lim = (pr + r) * k
                    if (px - x) ** 2 + (py - y) ** 2 < lim * lim:
                        return False
        return True

def streamlines(field, packer, seeds, dsep, rng, h=2.0):
    C, S, g = field
    def direction(x, y, prev):
        fx, fy = x / g, y / g
        i, j = int(fx), int(fy); tx, ty = fx - i, fy - j
        c = (C[j][i] * (1 - tx) + C[j][i + 1] * tx) * (1 - ty) + (C[j + 1][i] * (1 - tx) + C[j + 1][i + 1] * tx) * ty
        s = (S[j][i] * (1 - tx) + S[j][i + 1] * tx) * (1 - ty) + (S[j + 1][i] * (1 - tx) + S[j + 1][i + 1] * tx) * ty
        if c * c + s * s < 0.01:
            return None
        a = 0.5 * math.atan2(s, c)
        dx, dy = math.cos(a), math.sin(a)
        return (-dx, -dy) if dx * prev[0] + dy * prev[1] < 0 else (dx, dy)

    def trace(x, y, prev, lmax):
        pts, own = [], {}
        for n in range(int(lmax / h)):
            d1 = direction(x, y, prev)
            if not d1: break
            d2 = direction(x + d1[0] * h / 2, y + d1[1] * h / 2, d1)
            if not d2: break
            x, y = x + d2[0] * h, y + d2[1] * h
            if not (2 < x < W - 2 and 2 < y < H - 2) or not packer.free(x, y, dsep / 2, 0.6):
                break
            key = (int(x // dsep), int(y // dsep))
            if any((ox - x) ** 2 + (oy - y) ** 2 < (0.8 * dsep) ** 2 and n - k > 2 * dsep / h
                   for a in range(key[0] - 1, key[0] + 2) for b in range(key[1] - 1, key[1] + 2)
                   for ox, oy, k in own.get((a, b), ())):
                break  # ran into itself (vortex loop)
            own.setdefault(key, []).append((x, y, n))
            pts.append((x, y)); prev = d2
        return pts

    lines, queue = [], deque(seeds)
    grid_seeds = [(x + rng.uniform(0, dsep), y + rng.uniform(0, dsep))
                  for x in range(0, W, dsep) for y in range(0, H, dsep)]
    rng.shuffle(grid_seeds)
    while queue or grid_seeds:
        x, y = queue.popleft() if queue else grid_seeds.pop()
        if not (4 < x < W - 4 and 4 < y < H - 4) or not packer.free(x, y, dsep / 2, 0.95):
            continue
        d0 = direction(x, y, (1, 0))
        if not d0: continue
        lmax = rng.uniform(140, 700)
        fwd = trace(x, y, d0, lmax / 2)
        back = trace(x, y, (-d0[0], -d0[1]), lmax / 2)
        line = back[::-1] + [(x, y)] + fwd
        if len(line) * h < 30:
            continue
        packer.add(line, dsep / 2)
        lines.append(np.array(line))
        queue.extend(offset_seeds(np.array(line), dsep))
    return lines

def offset_seeds(line, dsep, every=6):
    if len(line) < 3: return []
    d = np.gradient(line, axis=0)
    n = np.column_stack([-d[:, 1], d[:, 0]]); n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    p, n = line[::every], n[::every]
    return [tuple(q) for q in np.vstack([p + n * dsep, p - n * dsep])]


# ---------- rendering
def ribbon(pts, wmax, profile):
    pts = resample(chaikin(pts[::3], 1) if len(pts) > 6 else pts, 2.5)
    if len(pts) < 3: return None
    d = np.gradient(pts, axis=0)
    n = np.column_stack([-d[:, 1], d[:, 0]]); n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    w = (wmax / 2 * profile(np.linspace(0, 1, len(pts))))[:, None]
    return np.vstack([pts + n * w, (pts - n * w)[::-1]])

brush = lambda t: np.sin(np.pi * t) ** 0.45 * (1 - 0.35 * t)
steady = lambda t: np.clip(np.minimum(t / 0.05, (1 - t) / 0.1), 0, 1) ** 0.5

def render(name, polys, circles, bg):
    img = Image.new("RGB", (W * SS, H * SS), bg)
    dr = ImageDraw.Draw(img)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">',
           f'<rect width="{W}" height="{H}" fill="rgb{bg}"/>']
    for poly, col in polys:
        dr.polygon([(x * SS, y * SS) for x, y in poly], fill=col)
        svg.append(f'<polygon fill="rgb{col}" points="' + " ".join(f"{x:.1f},{y:.1f}" for x, y in poly) + '"/>')
    for x, y, r, col in circles:
        dr.ellipse([(x - r) * SS, (y - r) * SS, (x + r) * SS, (y + r) * SS], fill=col)
        svg.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="rgb{col}"/>')
    img = img.resize((W, H), Image.LANCZOS)
    img.save(f"{OUT}/{name}.png")
    with open(f"{OUT}/{name}.svg", "w") as f:
        f.write("\n".join(svg + ["</svg>"]))
    return img

def make(name, word="AHOI", boat=True, size=270, center=(400, 480), angle=0.0,
         style=None, palette="sea", dsep=24, seed=1):
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    style = style or dict(tilt=10, amp=0.35, scale=180)
    bg, strokes_pal, letter_col = PALETTES[palette]
    strokes, dots, shapes = layout(word, size, center, angle, boat, rng)
    field = orientation_field(nrng, style, strokes, shapes, sigma=0.15 * size)

    packer = Packer(dsep)
    seeds = []
    for s in strokes:
        packer.add(s, dsep / 2); seeds += offset_seeds(s, dsep)
    for x, y, r in dots:
        packer.add([(x, y)], r + 0.1 * dsep)
    for poly, _ in shapes:
        outline = resample(np.vstack([poly, poly[:1]]), 3)
        packer.add(outline, dsep / 2); seeds += offset_seeds(outline, dsep)
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).polygon([tuple(p) for p in poly], fill=255)
        packer.add([(x, y) for y, x in np.argwhere(np.asarray(mask)[::6, ::6]) * 6], dsep / 2)

    lines = streamlines(field, packer, seeds, dsep, rng)

    cols, weights = zip(*strokes_pal)
    polys = []
    for ln in lines:
        if rng.random() < 0.5: ln = ln[::-1]
        p = ribbon(ln, dsep * rng.uniform(0.4, 0.78), brush)
        if p is not None: polys.append((p, rng.choices(cols, weights)[0]))
    polys += [(p, letter_col) for p in (ribbon(s, dsep * 0.72, steady) for s in strokes) if p is not None]
    polys += [(np.asarray(p), BOAT[k]) for p, k in shapes]
    circles = [(x, y, r, letter_col) for x, y, r in dots]
    print(f"{name}: {len(lines)} streamlines")
    return render(name, polys, circles, bg)

VARIANTS = [
    dict(name="1_sea_boat", size=230, center=(420, 480)),
    dict(name="2_sea_letterA", boat=False),
    dict(name="3_sunset_rotated", boat=False, angle=-28, palette="sunset", dsep=22,
         style=dict(tilt=-28, amp=0.55, scale=130), seed=3),
    dict(name="4_ink_vortices", boat=False, angle=6, palette="ink", dsep=20, size=300,
         style=dict(tilt=5, amp=0.4, scale=160, vortices=5), seed=4),
    dict(name="5_mint_turbulent_boat", palette="mint", size=230, center=(420, 480), style=dict(tilt=0, amp=1.0, scale=90), seed=5),
    dict(name="6_sea_vertical", boat=False, angle=-90, size=300, center=(400, 500),
         style=dict(tilt=-80, amp=0.35, scale=200), seed=6),
]

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    imgs = [make(**v) for v in VARIANTS]
    tw, th = W // 2, H // 2
    sheet = Image.new("RGB", (tw * 3, th * 2), "white")
    for i, im in enumerate(imgs):
        sheet.paste(im.resize((tw, th), Image.LANCZOS), ((i % 3) * tw, (i // 3) * th))
    sheet.save(f"{OUT}/sheet.png")
    print("saved sheet.png")

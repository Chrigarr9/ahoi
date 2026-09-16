const test = require("node:test");
const assert = require("node:assert");
const loadCore = require("./load-core");

const core = loadCore();

// Small canvas keeps generation fast: 20 x 25 cm, 8 mm spacing, no variety (even packing).
function design() {
  const d = core.defaultDesign();
  d.drawing.canvas = { widthCm: 20, heightCm: 25 };
  d.style.sea.spacingMm = 8;
  d.style.variety = { width: 0, spacing: 0, overlay: 0, accents: 0, surfers: 0 };
  return d;
}

function minDistanceBetween(linesA, linesB) {
  let best = Infinity;
  for (const a of linesA) for (const b of linesB) {
    if (a === b) continue;
    for (const [ax, ay] of a) for (const [bx, by] of b) best = Math.min(best, Math.hypot(ax - bx, ay - by));
  }
  return best;
}

const identity = { x: 0, y: 0, s: 1, r: 0 };
const verticalStroke = () => ({
  id: "s1", type: "stroke", transform: { ...identity },
  points: Array.from({ length: 41 }, (_, i) => [100, 40 + i * 4]),
});

test("sea streamlines stay at least half a spacing apart and clear of drawn strokes", () => {
  const d = design();
  d.drawing.elements = [verticalStroke()];
  const out = core.generate(d);
  const spacing = d.style.sea.spacingMm;

  assert.ok(minDistanceBetween(out.streamlines, out.streamlines) >= spacing / 2);
  assert.ok(minDistanceBetween(out.streamlines, [d.drawing.elements[0].points]) >= spacing / 2);
  assert.strictEqual(out.ribbons.filter((r) => r.kind === "letter").length, 1);
});

test("same design generates identical geometry; another seed does not", () => {
  const a = core.generate(design());
  const b = core.generate(design());
  assert.ok(a.ribbons.length > 20, `expected a filled sea, got ${a.ribbons.length} ribbons`);
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));

  const other = design();
  other.style.sea.seed += 1;
  assert.notStrictEqual(JSON.stringify(core.generate(other)), JSON.stringify(a));
});

// Share of streamline steps within `radius` mm of x=100 that run more vertical than horizontal.
function verticalShareNear(lines, radius) {
  let vertical = 0, total = 0;
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const [x, y] = line[i], [px, py] = line[i - 1];
    if (Math.abs(x - 100) > radius || y < 60 || y > 180) continue;
    total++;
    if (Math.abs(y - py) > Math.abs(x - px)) vertical++;
  }
  return vertical / total;
}

test("the flow bends along a drawn stroke, more strongly with higher bend", () => {
  const d = design();
  d.style.sea.turbulence = 0; // flat horizontal sea, so any vertical flow comes from the stroke
  d.drawing.elements = [verticalStroke()];

  d.style.letters.bend = 1;
  const strong = core.generate(d);
  assert.ok(verticalShareNear(strong.streamlines, 25) > 0.6, "sea next to the stroke should follow it");

  d.style.letters.bend = 0;
  const weak = core.generate(d);
  assert.ok(verticalShareNear(weak.streamlines, 25) < verticalShareNear(strong.streamlines, 25));
});

function insideRings(rings, x, y) {
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

test("dots, boats, shapes and imported SVGs are filled obstacles the sea never enters", () => {
  const d = design();
  d.drawing.elements = [
    { id: "d", type: "dot", transform: { x: 50, y: 50, s: 1, r: 0 }, radius: 6 },
    { id: "b", type: "boat", transform: { x: 120, y: 120, s: 1, r: 0.3 } },
    { id: "sh", type: "shape", transform: { ...identity }, color: "#aa5500",
      rings: [[[30, 180], [80, 180], [80, 220], [30, 220]]] },
    // two overlapping parts: the overlap must stay filled, not cancel out
    { id: "sv", type: "svg", transform: { x: 150, y: 210, s: 2, r: 0 }, color: "#112233",
      parts: [[[[-10, -10], [5, -10], [5, 10], [-10, 10]]], [[[-5, -10], [10, -10], [10, 10], [-5, 10]]]] },
  ];
  const out = core.generate(d);

  const known = {
    dot: (x, y) => Math.hypot(x - 50, y - 50) < 6,
    shape: (x, y) => x > 30 && x < 80 && y > 180 && y < 220,
    svg: (x, y) => x > 130 && x < 170 && y > 190 && y < 230,
  };
  assert.ok(out.fills.some((f) => f.color === "#aa5500") && out.fills.some((f) => f.color === "#112233"));
  const boatFills = out.fills.filter((f) => f.kind === "boat");
  assert.strictEqual(boatFills.length, 2, "boat = sail + hull");

  const svgFills = out.fills.filter((f) => f.kind === "svg");
  assert.ok(svgFills.length === 2 && svgFills.every((f) => insideRings(f.rings, 150, 210)), "overlap covered by both parts");

  for (const line of out.streamlines) for (const [x, y] of line) {
    for (const [name, inside] of Object.entries(known)) assert.ok(!inside(x, y), `streamline inside ${name} at ${x},${y}`);
    for (const f of boatFills) assert.ok(!insideRings(f.rings, x, y), `streamline inside boat at ${x},${y}`);
  }
});

test("width variety spreads sea stroke widths from thin to wide", () => {
  const spread = (variety) => {
    const d = design();
    d.style.variety.width = variety;
    const widths = core.generate(d).ribbons.filter((r) => r.kind === "sea").map((r) => r.width);
    return Math.max(...widths) / Math.min(...widths);
  };
  assert.ok(spread(0) < 1.7, `even sea spread ${spread(0)}`);
  assert.ok(spread(1) > 4, `varied sea spread ${spread(1)}`);
});

// Coefficient of variation of each sampled point's distance to the nearest other streamline.
function gapVariation(lines) {
  const gaps = [];
  lines.forEach((line, li) => {
    for (let p = 0; p < line.length; p += 15) {
      let best = Infinity;
      lines.forEach((other, oi) => {
        if (oi === li) return;
        for (let q = 0; q < other.length; q += 3) best = Math.min(best, Math.hypot(line[p][0] - other[q][0], line[p][1] - other[q][1]));
      });
      if (best < 40) gaps.push(best);
    }
  });
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / mean;
}

test("spacing variety makes dense and open patches", () => {
  const d = design();
  const even = gapVariation(core.generate(d).streamlines);
  d.style.variety.spacing = 1;
  const uneven = gapVariation(core.generate(d).streamlines);
  assert.ok(uneven > even * 1.5, `gap variation even ${even.toFixed(3)} vs uneven ${uneven.toFixed(3)}`);
});

const box = { id: "box", type: "shape", transform: { ...identity }, color: "#aa5500", rings: [[[30, 180], [80, 180], [80, 220], [30, 220]]] };
const inBox = ([x, y]) => x > 30 && x < 80 && y > 180 && y < 220;

test("overlay layer adds crossing strokes that still avoid letters and obstacles", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), box];
  assert.strictEqual(core.generate(d).ribbons.filter((r) => r.kind === "overlay").length, 0);

  d.style.variety.overlay = 1;
  const out = core.generate(d);
  assert.ok(out.ribbons.filter((r) => r.kind === "overlay").length > 10);
  assert.ok(minDistanceBetween(out.overlayStreamlines, [d.drawing.elements[0].points]) >= d.style.sea.spacingMm / 2);
  assert.ok(!out.overlayStreamlines.flat().some(inBox), "overlay inside obstacle");
});

test("accents scatter dots and flecks in the gaps, never on letters or obstacles", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), box];
  const accents = (o) => [...o.ribbons.filter((r) => r.kind === "accent").map((r) => r.points), ...o.fills.filter((f) => f.kind === "accent").map((f) => f.rings[0])];
  assert.strictEqual(accents(core.generate(d)).length, 0);

  d.style.variety.accents = 1;
  d.style.variety.spacing = 1; // open patches leave room for accents
  const found = accents(core.generate(d));
  assert.ok(found.length > 5, `only ${found.length} accents`);
  for (const pts of found) for (const p of pts) {
    assert.ok(!inBox(p), "accent inside obstacle");
    assert.ok(Math.abs(p[0] - 100) > 2 || p[1] < 38 || p[1] > 202, `accent on the letter stroke at ${p}`);
  }
});

// Corners and centre of a placed figure: [x, y, heading angle, length, width] in mm
function footprint({ x, y, angle, length, width }) {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  return [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) =>
    [x + (a * length / 2) * ux - (b * width / 2) * uy, y + (a * length / 2) * uy + (b * width / 2) * ux]);
}

// Checks shared by scattered figures and riding stamps: along the flow, clear of letters and shapes, wake behind
function assertRides(out, f, spacing) {
  for (const p of footprint(f)) {
    assert.ok(!inBox(p), "figure on the shape");
    assert.ok(Math.abs(p[0] - 100) >= spacing / 2 || p[1] < 36 || p[1] > 204, `figure on letter at ${p}`);
  }
  // heading follows the sea lines running close to the figure (orientation only: either way along the line)
  let best = null;
  for (const line of out.streamlines) for (let i = 1; i < line.length; i++) {
    const dist = Math.hypot(line[i][0] - f.x, line[i][1] - f.y);
    if (!best || dist < best.dist) best = { dist, a: Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]) };
  }
  const diff = Math.abs(Math.sin(best.a - f.angle));
  assert.ok(best.dist < spacing && diff < Math.sin(Math.PI / 7), `heading off the flow by ${Math.asin(diff)} rad`);
  // wake: foam in the palette's lightest colour, trailing behind the tail (it may curve with the flow)
  const along = (p) => (p[0] - f.x) * Math.cos(f.angle) + (p[1] - f.y) * Math.sin(f.angle);
  const wake = out.ribbons.filter((r) => r.kind === "wake" && r.figure === out.figures.indexOf(f));
  assert.ok(wake.length > 0, "figure without a wake");
  assert.ok(wake.every((r) => r.color === "#ffffff"), "wake colour");
  const pts = wake.flatMap((r) => r.points);
  assert.ok(pts.every((p) => along(p) < f.length * 0.1), "wake reaches in front of the figure");
  const tail = [f.x - (Math.cos(f.angle) * f.length) / 2, f.y - (Math.sin(f.angle) * f.length) / 2];
  assert.ok(Math.max(...pts.map((p) => Math.hypot(p[0] - tail[0], p[1] - tail[1]))) > f.length, "wake too short");
}
const seaUnder = (out, figures) => out.streamlines.some((line) => line.some(([px, py]) => figures.some((f) =>
  Math.abs((px - f.x) * Math.cos(f.angle) + (py - f.y) * Math.sin(f.angle)) < f.length / 3 &&
  Math.abs(-(px - f.x) * Math.sin(f.angle) + (py - f.y) * Math.cos(f.angle)) < f.width / 3)));

test("surfers from the figure library ride on top of the sea along the flow, away from letters and shapes, each with a wake", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), box];
  assert.strictEqual(core.generate(d).figures.length, 0);

  d.style.variety.surfers = 1;
  const out = core.generate(d);
  assert.ok(out.figures.length > 0, "no surfers placed");
  for (const f of out.figures) {
    assert.strictEqual(core.figure(f.figure).kind, "surfer", `${f.figure} is not a surfer`);
    assertRides(out, f, d.style.sea.spacingMm);
  }
  assert.ok(seaUnder(out, out.figures), "no sea under the surfers");
});

test("the boats slider scatters only boats, sized by boat size", () => {
  const d = design();
  d.drawing.canvas = { widthCm: 30, heightCm: 40 };
  d.style.variety.boats = 1;
  d.style.variety.boatSize = 5;
  const out = core.generate(d);
  assert.ok(out.figures.length > 0, "no boats placed");
  assert.ok(out.figures.every((f) => core.figure(f.figure).kind === "boat"), "a surfer among the boats");
  const lengths = out.figures.map((f) => f.length).sort((a, b) => a - b);
  assert.ok(lengths[0] >= 40 && lengths[lengths.length - 1] <= 100, `5 cm boats are ${lengths} mm long`);
});

const stamp = (extra) => ({ id: "st", type: "stamp", figure: "a00", mode: "riding", transform: { x: 150, y: 70, s: 1, r: null }, ...extra });

test("a riding stamp sits on top of the sea, turns to the flow, and trails a wake", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), box, stamp({ transform: { x: 172, y: 120, s: 0.5, r: null } })];
  const out = core.generate(d);
  const placed = out.figures.filter((f) => f.stamp === "st");
  assert.strictEqual(placed.length, 1);
  assert.strictEqual(placed[0].figure, "a00");
  assert.ok(Math.abs(placed[0].length - 20 * core.figure("a00").len) < 0.01, `stamp length ${placed[0].length}`);
  assertRides(out, placed[0], d.style.sea.spacingMm);
  // checked strip must be wider than the 8 mm line spacing for such a small stamp
  assert.ok(seaUnder(out, placed.map((f) => ({ ...f, width: f.width * 1.5 }))), "no sea under the riding stamp");
});

test("a stamp rotated and scaled by hand keeps that angle and size", () => {
  const d = design();
  d.drawing.elements = [stamp({ transform: { x: 150, y: 70, s: 1.5, r: 1 } })];
  const [placed] = core.generate(d).figures;
  assert.strictEqual(placed.angle, 1);
  assert.ok(Math.abs(placed.length - 60 * core.figure("a00").len) < 0.01);
});

test("an obstacle stamp makes the waves part around it", () => {
  const d = design();
  d.drawing.elements = [stamp({ figure: "a12", mode: "obstacle", transform: { x: 100, y: 120, s: 1, r: 0.3 } })];
  const out = core.generate(d);
  const [placed] = out.figures;
  assert.strictEqual(placed.angle, 0.3);
  assert.ok(!seaUnder(out, [placed]), "sea runs through the obstacle");
  assert.strictEqual(out.ribbons.filter((r) => r.kind === "wake").length, 0, "obstacles have no wake");
});

test("the letter boat can ride on top of the waves with a wake", () => {
  const d = design();
  d.drawing.elements = [{ id: "b1", type: "boat", mode: "riding", transform: { x: 100, y: 120, s: 0.5, r: 0 } }];
  const out = core.generate(d);
  const hull = out.fills.find((f) => f.kind === "boat" && f.rings[0].length === 4).rings;
  assert.ok(out.streamlines.some((line) => line.some(([x, y]) => core.insideRings(hull, x, y))), "sea parts around a riding boat");
  assert.ok(out.ribbons.some((r) => r.kind === "wake" && r.stamp === "b1"), "riding boat without a wake");
});

test("a stamp following the flow outside the canvas still gets a real angle", () => {
  const d = design();
  d.drawing.elements = [stamp({ transform: { x: 100, y: -80, s: 1, r: null } }), stamp({ id: "st2", transform: { x: 100, y: 400, s: 1, r: null } })];
  for (const f of core.generate(d).figures) assert.ok(Number.isFinite(f.angle), `stamp ${f.stamp} angle ${f.angle}`);
});

test("scattered surfers only come from the built-in library, so imports elsewhere never change a design", () => {
  const d = design();
  d.style.variety.surfers = 1;
  const before = JSON.stringify(core.generate(d).figures);
  core.registerFigures([{ id: "imported-x", kind: "surfer", len: 1, w: 200, h: 80, href: "data:image/png;base64,", imported: true }]);
  assert.strictEqual(JSON.stringify(core.generate(d).figures), before);
});

test("surfer size sets how long the surfers are printed", () => {
  const d = design();
  d.style.variety.surfers = 1;
  d.style.variety.surferSize = 3;
  const small = core.generate(d).figures;
  d.style.variety.surferSize = 6;
  const big = core.generate(d).figures;
  const median = (ss) => ss.map((s) => s.length).sort((a, b) => a - b)[ss.length >> 1];
  assert.ok(small.length && big.length);
  assert.ok(Math.abs(median(big) / median(small) - 2) < 0.6, `sizes ${median(small)} vs ${median(big)}`);
  assert.ok(median(small) > 20 && median(small) < 45, `3 cm surfers are ${median(small)} mm long`);
});

test("a woven shape becomes letter strokes along its outline with sea flowing inside", () => {
  const d = design();
  d.drawing.elements = [{ ...box, mode: "woven" }, { id: "b", type: "boat", mode: "woven", transform: { x: 120, y: 90, s: 0.8, r: 0 } }];
  const out = core.generate(d);

  assert.strictEqual(out.fills.length, 0, "woven elements have no flat fill");
  assert.strictEqual(out.ribbons.filter((r) => r.kind === "letter").length, 3, "box outline + sail + hull");
  assert.ok(out.streamlines.flat().some(inBox), "sea flows inside the woven box");
  const outline = [[30, 180], [80, 180], [80, 220], [30, 220], [30, 180]];
  const edgeDist = ([x, y]) => Math.min(...outline.slice(1).map((b, i) => {
    const a = outline[i], len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / len2));
    return Math.hypot(x - a[0] - t * (b[0] - a[0]), y - a[1] - t * (b[1] - a[1]));
  }));
  assert.ok(Math.min(...out.streamlines.flat().map(edgeDist)) >= d.style.sea.spacingMm / 2);
});

test("a wave-filled shape is filled with its own strokes in its colour, and the sea stays out", () => {
  const d = design();
  d.drawing.elements = [{ ...box, mode: "filled" }];
  const out = core.generate(d);

  assert.strictEqual(out.fills.length, 0);
  const inner = out.ribbons.filter((r) => r.kind === "shapefill");
  assert.ok(inner.length >= 3, `only ${inner.length} fill strokes`);
  const grown = ([x, y]) => x > 27 && x < 83 && y > 177 && y < 223; // box plus stroke half-width
  assert.ok(inner.every((r) => r.points.every(grown)), "fill strokes stay inside the shape");
  assert.ok(inner.some((r) => r.color === "#aa5500"));
  assert.ok(!out.streamlines.flat().some(inBox), "sea inside wave-filled shape");
});

test("a wavy border keeps the sea inside the enabled sides only", () => {
  const d = design();
  d.style.edges = { enabled: true, inset: 20, amplitude: 5, top: true, right: false, bottom: false, left: true };
  d.style.variety.overlay = 1;
  d.style.variety.accents = 1;
  const out = core.generate(d);
  const W = 200;

  const marks = [...out.streamlines.flat(), ...out.overlayStreamlines.flat(),
    ...out.ribbons.filter((r) => r.kind === "accent").flatMap((r) => r.points)];
  assert.ok(marks.every(([x, y]) => x >= 14 && y >= 14), "sea outside the top/left border");
  const ys = out.streamlines.flat().map((p) => p[1]);
  assert.ok(Math.min(...ys) < 22 && out.streamlines.flat().some(([x]) => x > W - 8), "right side stays open, border hugs the inset");

  // the border itself is wavy, not a straight line: the topmost sea point varies along x
  const topAt = (x0) => Math.min(...out.streamlines.flat().filter(([x]) => x >= x0 && x < x0 + 20).map((p) => p[1]));
  const tops = [30, 70, 110, 150].map(topAt);
  assert.ok(Math.max(...tops) - Math.min(...tops) > 3, `border tops ${tops}`);
});

test("moving the border leaves every sea stroke, overlay stroke and accent away from it exactly as it was", () => {
  const withBorder = (inset) => {
    const d = design();
    d.style.variety = { ...d.style.variety, width: 0.5, overlay: 0.5, accents: 0.5 };
    d.style.edges = { ...d.style.edges, enabled: true, inset, amplitude: 5, top: true, right: false, bottom: false, left: true };
    return core.generate(d);
  };
  const near = 30 + 5 + 8 * 4; // outer border line + waviness + a few spacings
  const away = (pts) => pts.every(([x, y]) => x > near && y > near);
  const interior = (out) => new Set([
    ...out.ribbons.filter((r) => ["sea", "overlay", "accent"].includes(r.kind) && away(r.points)).map((r) => JSON.stringify([r.kind, r.color, r.width, r.points])),
    ...out.fills.filter((f) => f.kind === "accent" && away(f.rings[0])).map((f) => JSON.stringify([f.color, f.rings])),
  ]);
  const a = interior(withBorder(20)), b = interior(withBorder(30));
  assert.ok(a.size > 40, `only ${a.size} interior strokes`);
  assert.deepStrictEqual([...b].filter((r) => !a.has(r)), []);
  assert.deepStrictEqual([...a].filter((r) => !b.has(r)), []);
});

test("scattered surfers and their wakes stay inside the border", () => {
  const d = design();
  d.style.variety.surfers = 1;
  d.style.edges = { ...d.style.edges, enabled: true, inset: 45, amplitude: 3, top: true, right: true, bottom: true, left: true };
  const out = core.generate(d);
  const inside = ([x, y]) => x > 41 && y > 41 && x < 200 - 41 && y < 250 - 41;
  assert.ok(out.figures.length > 0, "no surfers placed");
  assert.ok(out.figures.every((f) => inside([f.x, f.y])), "surfer outside the border");
  assert.ok(out.ribbons.filter((r) => r.kind === "wake").every((r) => r.points.every(([x, y]) => inside([x, y]) || Math.min(x - 41, y - 41, 159 - x, 209 - y) > -3)), "wake outside the border");
});

test("after a stroke-length change most of the canvas keeps its sea colour", () => {
  const colours = (length) => {
    const d = design();
    d.style.sea.length = length;
    d.style.palette.transparent = null;
    d.style.palette.strokes = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"].map((color) => ({ color, weight: 1 }));
    const at = new Map(); // colour per 4 mm cell
    for (const r of core.generate(d).ribbons.filter((r) => r.kind === "sea")) for (const [x, y] of r.points) at.set(`${Math.floor(x / 4)},${Math.floor(y / 4)}`, r.color);
    return at;
  };
  const before = colours(90), after = colours(95);
  const shared = [...after.keys()].filter((k) => before.has(k));
  const same = shared.filter((k) => before.get(k) === after.get(k)).length / shared.length;
  assert.ok(same > 0.4, `only ${Math.round(same * 100)}% kept its colour (a random reshuffle keeps 25%)`);
});

test("edge fade makes sea strokes near the border shorter, thinner and fewer, each on its own slider", () => {
  // straight border 20 mm in on the left and top; the fade reaches 40 mm further in
  const zone = ([x, y]) => x < 40 || y < 40; // the outer half of the fade
  const measure = (knobs) => {
    const d = design();
    d.style.sea.turbulence = 0.6;
    d.style.edges = { ...d.style.edges, enabled: true, inset: 20, amplitude: 0, top: true, left: true, right: false, bottom: false, fadeWidth: 40, ...knobs };
    const out = core.generate(d);
    const pieces = out.streamlines.filter((l) => zone(l[l.length >> 1]));
    const length = pieces.reduce((s, l) => s + lineLength(l), 0);
    const outer = out.ribbons.filter((r) => r.kind === "sea" && r.points.every(zone)).map((r) => r.points);
    const loop = (pts, f) => pts.reduce((a, p, i) => a + f(p, pts[(i + 1) % pts.length]), 0);
    const area = outer.reduce((a, pts) => a + Math.abs(loop(pts, (p, q) => (p[0] * q[1] - q[0] * p[1]) / 2)), 0);
    const perimeter = outer.reduce((a, pts) => a + loop(pts, (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1])), 0);
    return { meanLength: length / pieces.length, length, thickness: (2 * area) / perimeter }; // mean width of the outer strokes
  };
  const plain = measure({});
  const shorter = measure({ fadeShorter: 1 }), thinner = measure({ fadeThinner: 1 }), sparser = measure({ fadeSparser: 1 });
  assert.ok(shorter.meanLength < 0.6 * plain.meanLength, `shorter: ${shorter.meanLength} vs ${plain.meanLength} mm`);
  assert.ok(thinner.thickness < 0.75 * plain.thickness, `thinner: ${thinner.thickness} vs ${plain.thickness} mm`);
  assert.ok(sparser.length < 0.7 * plain.length, `sparser: ${sparser.length} vs ${plain.length} mm of strokes`);
  assert.ok(Math.abs(thinner.length - plain.length) < 1e-6, "thinner alone keeps every stroke");
});

// Direction samples of streamline segments: [x, y, dx, dy]
const segments = (lines, every = 6) => lines.flatMap((l) => l.filter((_, i) => i % every === 0 && i + 1 < l.length)
  .map((p, n) => { const q = l[n * every + 1]; const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [p[0], p[1], (q[0] - p[0]) / len, (q[1] - p[1]) / len]; }));
const turning = (line) => { let total = 0; for (let i = 2; i < line.length; i++) {
  const a = Math.atan2(line[i - 1][1] - line[i - 2][1], line[i - 1][0] - line[i - 2][0]);
  const b = Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]);
  total += Math.atan2(Math.sin(b - a), Math.cos(b - a)); } return Math.abs(total); };
const calm = () => { const d = design(); d.style.sea.turbulence = 0; d.style.sea.length = 300; return d; };

test("rings bend the sea into arcs around a centre below the canvas", () => {
  const d = calm();
  d.style.sea.rings = 1;
  const [cx, cy] = [100, 250 * 1.35];
  const radial = segments(core.generate(d).streamlines).map(([x, y, dx, dy]) => {
    const r = Math.hypot(x - cx, y - cy); return Math.abs((dx * (x - cx) + dy * (y - cy)) / r);
  });
  assert.ok(radial.filter((v) => v < 0.3).length / radial.length > 0.9, "flow should run along the arcs");
});

test("vortices curl streamlines into whirlpools", () => {
  const maxTurn = (v) => { const d = calm(); d.style.sea.vortices = v; return Math.max(...core.generate(d).streamlines.map(turning)); };
  assert.ok(maxTurn(0) < Math.PI / 2, "flat sea should not curl");
  assert.ok(maxTurn(6) > 1.5 * Math.PI, "vortices should curl lines around");
});

test("gradient makes the bottom of the sea rougher than the top", () => {
  const roughness = (gradient) => {
    const d = design();
    d.style.sea.turbulence = 0.8;
    d.style.sea.gradient = gradient;
    const segs = segments(core.generate(d).streamlines, 3);
    const spread = (half) => { const a = half.map(([, , dx, dy]) => Math.atan(dy / (dx || 1e-9))); const m = a.reduce((s, v) => s + v, 0) / a.length; return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length; };
    return spread(segs.filter((s) => s[1] > 170)) / spread(segs.filter((s) => s[1] < 80));
  };
  assert.ok(roughness(1) > 3 * roughness(0), `bottom/top roughness ${roughness(1)} vs flat ${roughness(0)}`);
});

test("fold marbles the flow into more winding lines", () => {
  const winding = (fold) => { const d = design(); d.style.sea.turbulence = 0.8; d.style.sea.fold = fold;
    const lines = core.generate(d).streamlines; return lines.reduce((s, l) => s + turning(l), 0) / lines.length; };
  assert.ok(winding(1) > 1.4 * winding(0), `fold ${winding(1)} vs ${winding(0)}`);
});

test("every flow preset produces a filled sea, and Ripcurl brings surfers", () => {
  const names = Object.keys(core.FLOW_PRESETS);
  for (const n of ["Calm", "Diagonal breeze", "Stormy", "Hokusai curls", "Reference look", "Ripples", "Whirlpool", "Undertow",
    "Marble", "Wind streaks", "Vertical rain", "Tidal rings", "Ripcurl"]) assert.ok(names.includes(n), `missing preset ${n}`);
  for (const n of names) {
    const d = design();
    core.applyFlowPreset(d.style, n);
    const out = core.generate(d);
    assert.ok(out.ribbons.length > 20, `${n}: ${out.ribbons.length} ribbons`);
    if (n === "Ripcurl") assert.ok(out.figures.length > 0, "Ripcurl without surfers");
  }
});

test("a transparent stroke colour marks those sea strokes as cut-outs, never letters or accents", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), { id: "dt", type: "dot", transform: { x: 150, y: 50, s: 1, r: 0 }, radius: 5 }];
  d.style.variety.overlay = 1;
  d.style.variety.accents = 1;
  d.style.variety.surfers = 1;
  d.style.palette.transparent = 0;
  const cutColor = (d.style.palette.strokes[0].color = "#ff00ff"); // used nowhere else in the palette
  const out = core.generate(d);

  const cut = out.ribbons.filter((r) => r.cutout);
  assert.ok(cut.length > 5 && cut.every((r) => r.kind === "sea" || r.kind === "overlay"));
  assert.ok(out.ribbons.filter((r) => !r.cutout && (r.kind === "sea" || r.kind === "overlay")).every((r) => r.color !== cutColor));
  assert.ok([...out.ribbons.filter((r) => r.kind === "letter" || r.kind === "accent"), ...out.fills].every((r) => !r.cutout && r.color !== cutColor));
  assert.strictEqual(out.background, d.style.palette.background);
});

test("a transparent background leaves the background empty", () => {
  const d = design();
  d.style.palette.transparent = "background";
  assert.strictEqual(core.generate(d).background, null);
});

test("smoothing straightens a jagged letter stroke without moving its ends", () => {
  const d = design();
  const zigzag = Array.from({ length: 31 }, (_, i) => [50 + i * 3, 120 + (i % 2 ? 3 : -3)]);
  d.drawing.elements = [{ id: "z", type: "stroke", transform: { ...identity }, points: zigzag }];
  const wobble = (line) => Math.max(...line.slice(8, -8).map(([, y]) => Math.abs(y - 120)));

  const rough = core.generate(d).letterStrokes[0];
  assert.ok(wobble(rough) > 2, `unsmoothed wobble ${wobble(rough)}`);

  d.style.letters.smooth = 1;
  const smooth = core.generate(d).letterStrokes[0];
  assert.ok(wobble(smooth) < 0.8, `smoothed wobble ${wobble(smooth)}`);
  const [first, last] = [smooth[0], smooth[smooth.length - 1]];
  assert.ok(Math.hypot(first[0] - 50, first[1] - 117) < 0.5 && Math.hypot(last[0] - 140, last[1] - 117) < 0.5, `ends ${first} ${last}`);
});

const lineLength = (l) => l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0);

test("continuous bands run much longer than dashes", () => {
  const d = design();
  d.style.sea.turbulence = 0.3;
  const mean = (lines) => lines.reduce((s, l) => s + lineLength(l), 0) / lines.length;
  const dashes = core.generate(d).streamlines;
  d.style.sea.strokeType = "bands";
  const bands = core.generate(d).streamlines;
  assert.ok(mean(bands) > 3 * mean(dashes), `bands ${mean(bands).toFixed(0)} mm vs dashes ${mean(dashes).toFixed(0)} mm`);
});

// Width along a ribbon polygon (left side then right side reversed), over its middle 60%.
function middleWidths(poly) {
  const n = poly.length / 2, widths = [];
  for (let i = Math.floor(n * 0.2); i < Math.ceil(n * 0.8); i++) widths.push(Math.hypot(poly[i][0] - poly[2 * n - 1 - i][0], poly[i][1] - poly[2 * n - 1 - i][1]));
  return widths;
}

test("bands swell and pinch along their length when swell is on", () => {
  const d = design();
  d.style.sea.turbulence = 0.2;
  d.style.sea.strokeType = "bands";
  const ratio = (swell) => {
    d.style.sea.swell = swell;
    const longest = core.generate(d).ribbons.filter((r) => r.kind === "sea").sort((a, b) => b.points.length - a.points.length).slice(0, 5);
    return Math.max(...longest.map((band) => { const w = middleWidths(band.points); return Math.max(...w) / Math.min(...w); }));
  };
  assert.ok(ratio(0) < 1.3, `steady band varies ${ratio(0)}`);
  assert.ok(ratio(1) > 2, `swelling band only varies ${ratio(1)}`);
});

// How often a line switches between climbing and falling, per 100 mm of its length.
function crestsPer100mm(lines) {
  let flips = 0, length = 0;
  for (const l of lines) {
    if (lineLength(l) < 80) continue;
    let prev = 0;
    for (let i = 6; i < l.length; i += 6) {
      const dy = l[i][1] - l[i - 6][1], dx = l[i][0] - l[i - 6][0];
      const slope = Math.abs(dx) > 1e-9 ? dy / Math.abs(dx) : 0;
      const sign = slope > 0.15 ? 1 : slope < -0.15 ? -1 : 0;
      if (sign && prev && sign !== prev) flips++;
      if (sign) prev = sign;
    }
    length += lineLength(l);
  }
  return (flips / length) * 100;
}

test("wave height makes each line itself rise and fall along its length", () => {
  const d = design();
  d.style.sea.turbulence = 0;
  d.style.sea.strokeType = "bands";
  d.style.sea.wavelength = 60;
  const flat = crestsPer100mm(core.generate(d).streamlines);
  d.style.sea.waves = 0.8;
  const wavy = crestsPer100mm(core.generate(d).streamlines);
  assert.ok(flat < 0.3, `flat sea flips ${flat.toFixed(2)} per 100 mm`);
  assert.ok(wavy > 2, `wavy sea flips only ${wavy.toFixed(2)} per 100 mm (expect ~3.3 for a 60 mm wavelength)`);
});

// ---------- paint: brushes, sizes, hidden or visible strokes
const distanceToLine = (line, [x, y]) => Math.min(...line.map(([px, py]) => Math.hypot(px - x, py - y)));

test("a visible stroke is painted in its own colour at its brush size, and the waves keep half a spacing clear of its edge", () => {
  const d = design();
  const spacing = d.style.sea.spacingMm;
  d.drawing.elements = [{ ...verticalStroke(), brush: "round", size: 20, mode: "visible", color: "#c0392b" }];
  const out = core.generate(d);

  const [paint] = out.ribbons.filter((r) => r.kind === "paint");
  assert.ok(paint, "no paint ribbon");
  assert.strictEqual(out.ribbons.filter((r) => r.kind === "letter").length, 0, "a visible stroke is not a hidden letter");
  assert.strictEqual(paint.color, "#c0392b");
  // mid-stroke the round brush is 20 mm across: its outline sits 10 mm either side of x = 100
  const mid = paint.points.filter(([, y]) => y > 100 && y < 140).map(([x]) => x);
  assert.ok(Math.abs(Math.min(...mid) - 90) < 0.5 && Math.abs(Math.max(...mid) - 110) < 0.5, `painted from ${Math.min(...mid)} to ${Math.max(...mid)}`);
  // the round cap reaches half the brush past the end (the shared resampler may stop one 0.8 mm step short of the last point)
  assert.ok(Math.max(...paint.points.map(([, y]) => y)) > 210 - 0.9, "round cap past the stroke's last point");
  const waves = out.streamlines.flat();
  assert.ok(waves.every(([x, y]) => !core.insideRings([paint.points], x, y)), "a wave runs through the paint");
  const nearest = Math.min(...waves.map((p) => distanceToLine(paint.points, p)));
  assert.ok(nearest >= spacing / 2, `a wave comes within ${nearest} mm of the painted edge`);
});

test("strokes painted before brushes existed generate exactly like hidden, tapered, automatic-width strokes", () => {
  const old = design();
  old.drawing.elements = [verticalStroke(), { id: "z", type: "stroke", transform: { x: 30, y: 60, s: 1.2, r: 0.3 }, points: [[0, 0], [20, 30], [60, 10]] }];
  const explicit = JSON.parse(JSON.stringify(old));
  for (const el of explicit.drawing.elements) Object.assign(el, { brush: "tapered", size: "auto", mode: "hidden", nib: 45 });
  assert.strictEqual(JSON.stringify(core.generate(explicit)), JSON.stringify(core.generate(old)));
  assert.strictEqual(core.generate(old).ribbons.filter((r) => r.kind === "letter").length, 2);
});

// widest extent of a paint outline across a line through (x, y) perpendicular to `dir` ("x" or "y")
const thickness = (ring, dir, at) => {
  const near = ring.filter((p) => Math.abs(p[dir === "x" ? 0 : 1] - at) < 1.5).map((p) => p[dir === "x" ? 1 : 0]);
  return Math.max(...near) - Math.min(...near);
};

test("a calligraphy stroke is thick across the nib and thin along it", () => {
  const d = design();
  const nib = { brush: "calligraphy", size: 16, mode: "visible", nib: 0 };
  d.drawing.elements = [
    { id: "h", type: "stroke", transform: { ...identity }, points: Array.from({ length: 21 }, (_, i) => [40 + i * 4, 60]), ...nib },
    { id: "v", type: "stroke", transform: { ...identity }, points: Array.from({ length: 21 }, (_, i) => [150, 100 + i * 4]), ...nib },
  ];
  const [h, v] = core.generate(d).ribbons.filter((r) => r.kind === "paint").map((r) => r.points);
  // a horizontal nib (0°): a horizontal stroke runs along it, a vertical one across it
  assert.ok(thickness(h, "x", 80) < 16 * 0.2, `horizontal stroke ${thickness(h, "x", 80)} mm thick`);
  assert.ok(Math.abs(thickness(v, "y", 140) - 16) < 0.5, `vertical stroke ${thickness(v, "y", 140)} mm thick`);

  for (const el of d.drawing.elements) el.nib = 90; // turning the nib swaps them
  const [h2, v2] = core.generate(d).ribbons.filter((r) => r.kind === "paint").map((r) => r.points);
  assert.ok(Math.abs(thickness(h2, "x", 80) - 16) < 0.5 && thickness(v2, "y", 140) < 16 * 0.2, `nib 90°: ${thickness(h2, "x", 80)} / ${thickness(v2, "y", 140)}`);
});

test("pen pressure scales a stroke's width along its length", () => {
  const d = design();
  // pressed lightly at the top and hard at the bottom
  const points = Array.from({ length: 21 }, (_, i) => [100, 40 + i * 8]);
  d.drawing.elements = [{ id: "p", type: "stroke", transform: { ...identity }, points, brush: "round", size: 20, mode: "visible",
    pressure: points.map((_, i) => i / 20) }];
  const [ring] = core.generate(d).ribbons.filter((r) => r.kind === "paint").map((r) => r.points);
  const light = thickness(ring, "y", 60), hard = thickness(ring, "y", 180);
  assert.ok(hard > 16 && light < 8 && light > 2, `light end ${light} mm, hard end ${hard} mm`);

  delete d.drawing.elements[0].pressure; // no pressure: the full brush size all along
  const [even] = core.generate(d).ribbons.filter((r) => r.kind === "paint").map((r) => r.points);
  assert.ok(Math.abs(thickness(even, "y", 60) - 20) < 0.5, `without pressure ${thickness(even, "y", 60)} mm`);
});

test("paint in a palette colour follows palette changes, while a custom colour stays", () => {
  const d = design();
  const along = (x) => Array.from({ length: 21 }, (_, i) => [x, 40 + i * 8]);
  d.drawing.elements = [
    { id: "slot", type: "stroke", transform: { ...identity }, points: along(50), brush: "round", size: 10, mode: "visible", color: { palette: 1 } },
    { id: "letter", type: "stroke", transform: { ...identity }, points: along(100), brush: "round", size: 10, mode: "visible", color: { palette: "letter" } },
    { id: "own", type: "stroke", transform: { ...identity }, points: along(150), brush: "round", size: 10, mode: "visible", color: "#123abc" },
  ];
  const colours = () => [...core.generate(d).ribbons.filter((r) => r.kind === "paint").map((r) => r.color)]; // an array of this realm
  d.style.palette.strokes[1].color = "#00aa00";
  d.style.palette.letter = "#aa0000";
  assert.deepStrictEqual(colours(), ["#00aa00", "#aa0000", "#123abc"]);
  d.style.palette.strokes[1].color = "#0000aa";
  d.style.palette.letter = "#aaaa00";
  assert.deepStrictEqual(colours(), ["#0000aa", "#aaaa00", "#123abc"]);
});

test("a tap paints a round dot the size of the brush that the waves keep clear of", () => {
  const d = design();
  const spacing = d.style.sea.spacingMm;
  d.drawing.elements = [{ id: "t", type: "stroke", transform: { x: 100, y: 120, s: 1, r: 0 }, points: [[0, 0]], brush: "tapered", size: 18, mode: "visible", color: "#ff8800" }];
  const out = core.generate(d);
  const [dot] = out.ribbons.filter((r) => r.kind === "paint");
  assert.ok(dot, "no dot painted");
  const radii = dot.points.map(([x, y]) => Math.hypot(x - 100, y - 120));
  assert.ok(Math.min(...radii) > 8.9 && Math.max(...radii) < 9.1, `dot radius ${Math.min(...radii)}..${Math.max(...radii)}`);
  const nearest = Math.min(...out.streamlines.flat().map(([x, y]) => Math.hypot(x - 100, y - 120)));
  assert.ok(nearest >= 9 + spacing / 2, `a wave comes within ${nearest} mm of the dot's centre`);
});

test("erasing through a pressure stroke keeps the pressure and brush on both pieces", () => {
  const points = Array.from({ length: 21 }, (_, i) => [40 + i * 6, 100]); // x 40..160
  const el = { id: "p", type: "stroke", transform: { ...identity }, points, brush: "calligraphy", size: 14, mode: "visible", color: { palette: 2 }, nib: 30,
    pressure: points.map(([x]) => (x - 40) / 120) };
  let n = 0;
  const { elements } = core.eraseStrokes([el], 100, 100, 5, () => "new" + n++);
  assert.strictEqual(elements.length, 2);
  for (const piece of elements) {
    assert.deepStrictEqual({ ...piece, id: 0, transform: 0, points: 0, pressure: 0 },
      { id: 0, type: "stroke", transform: 0, points: 0, pressure: 0, brush: "calligraphy", size: 14, mode: "visible", color: { palette: 2 }, nib: 30 });
    assert.strictEqual(piece.pressure.length, piece.points.length);
    // pressure still grows with x: at every point it matches where that point lies on the original stroke
    piece.points.forEach((p, i) => {
      const [x] = core.applyTransform(piece.transform, p);
      assert.ok(Math.abs(piece.pressure[i] - (x - 40) / 120) < 0.01, `pressure ${piece.pressure[i]} at x ${x}`);
    });
  }
});

const textElement = (props = {}) => ({ id: "tx", type: "text", transform: { x: 100, y: 125, s: 1, r: 0 }, text: "HIH", font: "Readability",
  heightCm: 4, lineSpacing: 1.2, letterSpacing: 0, slant: 0, align: "center", brush: "round", size: 3, mode: "visible", color: "#aa0000", ...props });
const bounds = (lines) => {
  const pts = lines.flat();
  return { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])) };
};

test("typed text paints its letters as brush strokes, capitals as tall as the letter height, centred on the element, with the waves kept clear", () => {
  const d = design();
  d.drawing.elements = [textElement()];
  const out = core.generate(d);

  const paint = out.ribbons.filter((r) => r.kind === "paint");
  assert.ok(paint.length >= 3 && paint.every((r) => r.color === "#aa0000"), `${paint.length} painted letter strokes`);
  const b = bounds(out.letterStrokes);
  assert.ok(Math.abs(b.y1 - b.y0 - 40) < 1, `capital H is ${b.y1 - b.y0} mm tall`);
  assert.ok(Math.abs((b.x0 + b.x1) / 2 - 100) < 1 && Math.abs((b.y0 + b.y1) / 2 - 125) < 1, "text centred on its position");
  const waves = out.streamlines.flat();
  const nearest = Math.min(...paint.map((r) => Math.min(...waves.map((p) => distanceToLine(r.points, p)))));
  assert.ok(nearest >= d.style.sea.spacingMm / 2, `a wave comes within ${nearest} mm of a painted letter`);
});

test("font, letter spacing, line spacing, alignment and slant each reshape typed text", () => {
  const lines = (props) => core.textLines(textElement(props));
  const size = (props) => { const b = bounds(lines(props)); return { w: b.x1 - b.x0, h: b.y1 - b.y0 }; };
  const plain = size({});

  assert.notDeepStrictEqual(lines({ font: "Allure" }), lines({}), "another font draws other letters");
  assert.ok(Math.abs(size({ letterSpacing: 0.5 }).w - plain.w - 2 * 0.5 * 40) < 0.5, "letter spacing adds half a letter height between each of three letters");
  // two lines of H: 40 mm letters, baselines 2 letter heights apart -> 80 + 40 mm tall
  assert.ok(Math.abs(size({ text: "H\nH", lineSpacing: 2 }).h - 120) < 0.5, `two lines ${size({ text: "H\nH", lineSpacing: 2 }).h} mm tall`);

  // a short line under a long one: its letters sit at the left edge, the middle or the right edge of the long line
  const shortLine = (align) => { const all = lines({ text: "HIHIH\nI", align }); const b = bounds(all);
    const low = bounds(all.filter((pts) => pts.every(([, y]) => y > (b.y0 + b.y1) / 2))); return [low.x0 - b.x0, b.x1 - low.x1]; };
  const [leftGap] = shortLine("left"), [cLeft, cRight] = shortLine("center"), [, rightGap] = shortLine("right");
  assert.ok(leftGap < 8 && rightGap < 8 && Math.abs(cLeft - cRight) < 1, `left ${leftGap}, centre ${cLeft}/${cRight}, right ${rightGap}`);

  // slanted, the top of the upright I leans to the right of its foot
  const stem = lines({ text: "I", slant: 20 }).sort((a, b) => b.length - a.length)[0];
  const [top, foot] = [stem.reduce((a, p) => (p[1] < a[1] ? p : a)), stem.reduce((a, p) => (p[1] > a[1] ? p : a))];
  assert.ok(Math.abs((top[0] - foot[0]) / (foot[1] - top[1]) - Math.tan((20 * Math.PI) / 180)) < 0.05, "leans by the slant angle");
});

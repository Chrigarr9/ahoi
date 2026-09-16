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
  const out = core.generate(d, "full");
  const spacing = d.style.sea.spacingMm;

  assert.ok(minDistanceBetween(out.streamlines, out.streamlines) >= spacing / 2);
  assert.ok(minDistanceBetween(out.streamlines, [d.drawing.elements[0].points]) >= spacing / 2);
  assert.strictEqual(out.ribbons.filter((r) => r.kind === "letter").length, 1);
});

test("same design generates identical geometry; another seed does not", () => {
  const a = core.generate(design(), "full");
  const b = core.generate(design(), "full");
  assert.ok(a.ribbons.length > 20, `expected a filled sea, got ${a.ribbons.length} ribbons`);
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));

  const other = design();
  other.style.sea.seed += 1;
  assert.notStrictEqual(JSON.stringify(core.generate(other, "full")), JSON.stringify(a));
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
  const strong = core.generate(d, "full");
  assert.ok(verticalShareNear(strong.streamlines, 25) > 0.6, "sea next to the stroke should follow it");

  d.style.letters.bend = 0;
  const weak = core.generate(d, "full");
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
  const out = core.generate(d, "full");

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
    const widths = core.generate(d, "full").ribbons.filter((r) => r.kind === "sea").map((r) => r.width);
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
  const even = gapVariation(core.generate(d, "full").streamlines);
  d.style.variety.spacing = 1;
  const uneven = gapVariation(core.generate(d, "full").streamlines);
  assert.ok(uneven > even * 1.5, `gap variation even ${even.toFixed(3)} vs uneven ${uneven.toFixed(3)}`);
});

const box = { id: "box", type: "shape", transform: { ...identity }, color: "#aa5500", rings: [[[30, 180], [80, 180], [80, 220], [30, 220]]] };
const inBox = ([x, y]) => x > 30 && x < 80 && y > 180 && y < 220;

test("overlay layer adds crossing strokes that still avoid letters and obstacles", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), box];
  assert.strictEqual(core.generate(d, "full").ribbons.filter((r) => r.kind === "overlay").length, 0);

  d.style.variety.overlay = 1;
  const out = core.generate(d, "full");
  assert.ok(out.ribbons.filter((r) => r.kind === "overlay").length > 10);
  assert.ok(minDistanceBetween(out.overlayStreamlines, [d.drawing.elements[0].points]) >= d.style.sea.spacingMm / 2);
  assert.ok(!out.overlayStreamlines.flat().some(inBox), "overlay inside obstacle");
});

test("accents scatter dots and flecks in the gaps, never on letters or obstacles", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), box];
  const accents = (o) => [...o.ribbons.filter((r) => r.kind === "accent").map((r) => r.points), ...o.fills.filter((f) => f.kind === "accent").map((f) => f.rings[0])];
  assert.strictEqual(accents(core.generate(d, "full")).length, 0);

  d.style.variety.accents = 1;
  d.style.variety.spacing = 1; // open patches leave room for accents
  const found = accents(core.generate(d, "full"));
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
  assert.strictEqual(core.generate(d, "full").figures.length, 0);

  d.style.variety.surfers = 1;
  const out = core.generate(d, "full");
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
  const out = core.generate(d, "full");
  assert.ok(out.figures.length > 0, "no boats placed");
  assert.ok(out.figures.every((f) => core.figure(f.figure).kind === "boat"), "a surfer among the boats");
  const lengths = out.figures.map((f) => f.length).sort((a, b) => a - b);
  assert.ok(lengths[0] >= 40 && lengths[lengths.length - 1] <= 100, `5 cm boats are ${lengths} mm long`);
});

const stamp = (extra) => ({ id: "st", type: "stamp", figure: "a00", mode: "riding", transform: { x: 150, y: 70, s: 1, r: null }, ...extra });

test("a riding stamp sits on top of the sea, turns to the flow, and trails a wake", () => {
  const d = design();
  d.drawing.elements = [verticalStroke(), box, stamp({ transform: { x: 172, y: 120, s: 0.5, r: null } })];
  const out = core.generate(d, "full");
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
  const [placed] = core.generate(d, "full").figures;
  assert.strictEqual(placed.angle, 1);
  assert.ok(Math.abs(placed.length - 60 * core.figure("a00").len) < 0.01);
});

test("an obstacle stamp makes the waves part around it", () => {
  const d = design();
  d.drawing.elements = [stamp({ figure: "a12", mode: "obstacle", transform: { x: 100, y: 120, s: 1, r: 0.3 } })];
  const out = core.generate(d, "full");
  const [placed] = out.figures;
  assert.strictEqual(placed.angle, 0.3);
  assert.ok(!seaUnder(out, [placed]), "sea runs through the obstacle");
  assert.strictEqual(out.ribbons.filter((r) => r.kind === "wake").length, 0, "obstacles have no wake");
});

test("the letter boat can ride on top of the waves with a wake", () => {
  const d = design();
  d.drawing.elements = [{ id: "b1", type: "boat", mode: "riding", transform: { x: 100, y: 120, s: 0.5, r: 0 } }];
  const out = core.generate(d, "full");
  const hull = out.fills.find((f) => f.kind === "boat" && f.rings[0].length === 4).rings;
  assert.ok(out.streamlines.some((line) => line.some(([x, y]) => core.insideRings(hull, x, y))), "sea parts around a riding boat");
  assert.ok(out.ribbons.some((r) => r.kind === "wake" && r.stamp === "b1"), "riding boat without a wake");
});

test("a stamp following the flow outside the canvas still gets a real angle", () => {
  const d = design();
  d.drawing.elements = [stamp({ transform: { x: 100, y: -80, s: 1, r: null } }), stamp({ id: "st2", transform: { x: 100, y: 400, s: 1, r: null } })];
  for (const f of core.generate(d, "full").figures) assert.ok(Number.isFinite(f.angle), `stamp ${f.stamp} angle ${f.angle}`);
});

test("scattered surfers only come from the built-in library, so imports elsewhere never change a design", () => {
  const d = design();
  d.style.variety.surfers = 1;
  const before = JSON.stringify(core.generate(d, "full").figures);
  core.registerFigures([{ id: "imported-x", kind: "surfer", len: 1, w: 200, h: 80, href: "data:image/png;base64,", imported: true }]);
  assert.strictEqual(JSON.stringify(core.generate(d, "full").figures), before);
});

test("surfer size sets how long the surfers are printed", () => {
  const d = design();
  d.style.variety.surfers = 1;
  d.style.variety.surferSize = 3;
  const small = core.generate(d, "full").figures;
  d.style.variety.surferSize = 6;
  const big = core.generate(d, "full").figures;
  const median = (ss) => ss.map((s) => s.length).sort((a, b) => a - b)[ss.length >> 1];
  assert.ok(small.length && big.length);
  assert.ok(Math.abs(median(big) / median(small) - 2) < 0.6, `sizes ${median(small)} vs ${median(big)}`);
  assert.ok(median(small) > 20 && median(small) < 45, `3 cm surfers are ${median(small)} mm long`);
});

test("a woven shape becomes letter strokes along its outline with sea flowing inside", () => {
  const d = design();
  d.drawing.elements = [{ ...box, mode: "woven" }, { id: "b", type: "boat", mode: "woven", transform: { x: 120, y: 90, s: 0.8, r: 0 } }];
  const out = core.generate(d, "full");

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
  const out = core.generate(d, "full");

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
  const out = core.generate(d, "full");
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
  const radial = segments(core.generate(d, "full").streamlines).map(([x, y, dx, dy]) => {
    const r = Math.hypot(x - cx, y - cy); return Math.abs((dx * (x - cx) + dy * (y - cy)) / r);
  });
  assert.ok(radial.filter((v) => v < 0.3).length / radial.length > 0.9, "flow should run along the arcs");
});

test("vortices curl streamlines into whirlpools", () => {
  const maxTurn = (v) => { const d = calm(); d.style.sea.vortices = v; return Math.max(...core.generate(d, "full").streamlines.map(turning)); };
  assert.ok(maxTurn(0) < Math.PI / 2, "flat sea should not curl");
  assert.ok(maxTurn(6) > 1.5 * Math.PI, "vortices should curl lines around");
});

test("gradient makes the bottom of the sea rougher than the top", () => {
  const roughness = (gradient) => {
    const d = design();
    d.style.sea.turbulence = 0.8;
    d.style.sea.gradient = gradient;
    const segs = segments(core.generate(d, "full").streamlines, 3);
    const spread = (half) => { const a = half.map(([, , dx, dy]) => Math.atan(dy / (dx || 1e-9))); const m = a.reduce((s, v) => s + v, 0) / a.length; return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length; };
    return spread(segs.filter((s) => s[1] > 170)) / spread(segs.filter((s) => s[1] < 80));
  };
  assert.ok(roughness(1) > 3 * roughness(0), `bottom/top roughness ${roughness(1)} vs flat ${roughness(0)}`);
});

test("fold marbles the flow into more winding lines", () => {
  const winding = (fold) => { const d = design(); d.style.sea.turbulence = 0.8; d.style.sea.fold = fold;
    const lines = core.generate(d, "full").streamlines; return lines.reduce((s, l) => s + turning(l), 0) / lines.length; };
  assert.ok(winding(1) > 1.4 * winding(0), `fold ${winding(1)} vs ${winding(0)}`);
});

test("every flow preset produces a filled sea, and Ripcurl brings surfers", () => {
  const names = Object.keys(core.FLOW_PRESETS);
  for (const n of ["Calm", "Diagonal breeze", "Stormy", "Hokusai curls", "Reference look", "Ripples", "Whirlpool", "Undertow",
    "Marble", "Wind streaks", "Vertical rain", "Tidal rings", "Ripcurl"]) assert.ok(names.includes(n), `missing preset ${n}`);
  for (const n of names) {
    const d = design();
    core.applyFlowPreset(d.style, n);
    const out = core.generate(d, "preview");
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
  const out = core.generate(d, "full");

  const cut = out.ribbons.filter((r) => r.cutout);
  assert.ok(cut.length > 5 && cut.every((r) => r.kind === "sea" || r.kind === "overlay"));
  assert.ok(out.ribbons.filter((r) => !r.cutout && (r.kind === "sea" || r.kind === "overlay")).every((r) => r.color !== cutColor));
  assert.ok([...out.ribbons.filter((r) => r.kind === "letter" || r.kind === "accent"), ...out.fills].every((r) => !r.cutout && r.color !== cutColor));
  assert.strictEqual(out.background, d.style.palette.background);
});

test("a transparent background leaves the background empty", () => {
  const d = design();
  d.style.palette.transparent = "background";
  assert.strictEqual(core.generate(d, "preview").background, null);
});

test("smoothing straightens a jagged letter stroke without moving its ends", () => {
  const d = design();
  const zigzag = Array.from({ length: 31 }, (_, i) => [50 + i * 3, 120 + (i % 2 ? 3 : -3)]);
  d.drawing.elements = [{ id: "z", type: "stroke", transform: { ...identity }, points: zigzag }];
  const wobble = (line) => Math.max(...line.slice(8, -8).map(([, y]) => Math.abs(y - 120)));

  const rough = core.generate(d, "full").letterStrokes[0];
  assert.ok(wobble(rough) > 2, `unsmoothed wobble ${wobble(rough)}`);

  d.style.letters.smooth = 1;
  const smooth = core.generate(d, "full").letterStrokes[0];
  assert.ok(wobble(smooth) < 0.8, `smoothed wobble ${wobble(smooth)}`);
  const [first, last] = [smooth[0], smooth[smooth.length - 1]];
  assert.ok(Math.hypot(first[0] - 50, first[1] - 117) < 0.5 && Math.hypot(last[0] - 140, last[1] - 117) < 0.5, `ends ${first} ${last}`);
});

const lineLength = (l) => l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0);

test("continuous bands run much longer than dashes", () => {
  const d = design();
  d.style.sea.turbulence = 0.3;
  const mean = (lines) => lines.reduce((s, l) => s + lineLength(l), 0) / lines.length;
  const dashes = core.generate(d, "full").streamlines;
  d.style.sea.strokeType = "bands";
  const bands = core.generate(d, "full").streamlines;
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
    const longest = core.generate(d, "full").ribbons.filter((r) => r.kind === "sea").sort((a, b) => b.points.length - a.points.length)[0];
    const w = middleWidths(longest.points);
    return Math.max(...w) / Math.min(...w);
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
  const flat = crestsPer100mm(core.generate(d, "full").streamlines);
  d.style.sea.waves = 0.8;
  const wavy = crestsPer100mm(core.generate(d, "full").streamlines);
  assert.ok(flat < 0.3, `flat sea flips ${flat.toFixed(2)} per 100 mm`);
  assert.ok(wavy > 2, `wavy sea flips only ${wavy.toFixed(2)} per 100 mm (expect ~3.3 for a 60 mm wavelength)`);
});

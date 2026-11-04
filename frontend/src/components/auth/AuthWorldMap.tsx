import { useEffect, useRef } from 'react';

/**
 * The world-map wall inside the panel on the left of the sign-in pages: the continents as a
 * glowing dot grid on a dark screen, a fine network over the land, hub cities that pulse, and light
 * travelling along arcs between them, with the wall's reflection on the floor below.
 *
 * Decorative only. Nothing is labelled and no line stands for an order, a visitor or any other
 * figure. The hubs are well-known cities at their real positions, nothing more.
 *
 * The land is Natural Earth outlines sampled on a 190 × 100 Mercator grid (latitudes −56° to 76°),
 * generated once with the MIT `dotted-map` package, which is not a runtime dependency. Each row is
 * hex, one bit per column, most significant bit first.
 *
 * Same rules as the network in AuthBackdrop: one still frame under prefers-reduced-motion, the loop
 * pauses while the tab is hidden, and nothing is drawn at 0 × 0 (the panel is display:none below
 * `lg`).
 */

const MAP_COLS = 190;
const MAP_ROWS = 100;

const LAND_ROWS = [
  '0000000268e60001fffff00000000001c0005ff000e00000', '00000000f66f7000fffff000000000038001fff000f00000',
  '000000001c7bf000fffff000000000060007ffe000f60000', '000000003001f000fffff000000000060007ffc000000000',
  '00000007800c00007ffff0000000000c0007ffc000000000', '00000007826cac007ffff0000000000c003fffec60200000',
  '0000000f466dbc007fffe00000000018003fffff70000000', '0000000efee9f4003fffe000000000180c3ffffff0780000',
  '0000000efe61fe007fffe000000000381dfffffff07e0000', '001000047e29ff801fffa000000000181afffffff7ff0000',
  '003c0000ff0dffc03fffa000000e00001dfffffffffff000', '00ffe0407f8c7fe03fffe000003e00001ffffffffffff000',
  '00fff9fe7f3e63e02fffc000007f80019fffffffffffffbc', '03fffffff20771c00fff800000ffe011cdfffffffffffffc',
  '81ffffffc73f62f01ffc000001fff33ffdfffffffffffffc', 'c0fffffffffff2f83ff8000001fffa7ffdfffffffffffffc',
  'f0ffffffffffe0fc3ff8000003ffb9fffbfffffffffffffc', 'f3ffffffffff81ec1fe03e0003efc7fffffffffffffffffc',
  '63ffffffffffc7e01f801f0007cfcffffffffffffffffffc', '007fffffffff60f01f801e000fdfdffffffffffffffffffc',
  '18fffffffffe40f00f8000001f9ffffffffffffffffffffc', '01fffffffffc20200f0000003f3ffffffffffffffffffffc',
  '03fffffffff80f80070000003f3ffffffffffffffffffff0', '01ff7ffffff803c0030000003f3fffffffffffffffffcbe0',
  '02fb0ffffff803c8000000003f83ffffffffffffffff8600', '003807fffff807c800000000371fffffffffffffffe00c00',
  '001400fffff803fc00000008070fffffffffffffffc01800', '002000fffffe03fc0000000c173fffffffffffffff803c00',
  '0040007fffff83fe0000000c163fffffffffffffff003800', '0100007fffffe7ff0000001c00bffffffffffffffe003800',
  '000000bfffffe7ff800000361fffffffffffffffffc03000', '0000003fffffe7ff800000277fffffffffffffffffe02000',
  '0000001ffffff7ff000000077fffffffffffffffffc02000', '0000001ffffffff680000000ffffffffffffffffffd00000',
  '0000000fffffffd8c0000003ffffffffffffffffffc00000', '00000003fffffff1e0000007ffffffffffffffffff800000',
  '00000007fffffffa00000003fffedf9fffffffffff800000', '00000007ffffffec00000003fffe5f3fffffffffff000000',
  '00000007ffffffc000000003edfc0f3ffffffffffe300000', '00000007ffffff800000003f867c079ffffffffff8100000',
  '00000007ffffff800000003f037de78ffffffffff0000000', '00000007fffffe000000003e1127ff9ffffffffe20200000',
  '00000007fffffe000000003e0137ff8ffffffffc70400000', '00000003fffffe0000000008f802bfffffffffff30c00000',
  '00000001fffffc000000000ff808bffffffffffe37c00000', '00000000fffff8000000001ff8003ffffffffffe0a000000',
  '000000007ffff0000000003ffe307fffffffffff08000000', '000000005ffff0000000003fffffffffffffffff00000000',
  '000000003ff010000000007fffff3fbfffffffff00000000', '000000002fe01000000000ffffffbf9ffffffffe00000000',
  '0000000017e00000000001ffffff9fc9fffffffe00000000', '000000000be00000000003ffffffdffc1ffffffd00000000',
  '0000000001e00c00000003ffffffeffe0ffcffe000000000', '0000000001e10200000003ffffffeffc03f8ff0000000000',
  '0000000000f705d0000003ffffffe7f803f07f4100000000', '00000000003f0000000003fffffff3e003e07f0100000000',
  '000000000003e000000003fffffffbc001c01f8100000000', '000000000000c000000003fffffffe0001c0178100000000',
  '00000000000041c0000001fffffffcc001c00380c0000000', '0000000000002bfe000000ffffffffc00080110080000000',
  '00000000000007ff000000ffffffff800020080040000000', '00000000000003ffe000003e3fffff8000000c0400000000',
  '00000000000003fff00000000fffff000000141c00000000', '00000000000007fff00000000ffffe0000000a7c00000000',
  '0000000000000ffff00000000ffffc0000000c7c00000000', '0000000000000ffffe0000000ffff8000000063906800000',
  '0000000000000fffffe0000007fff0000000020001f00000', '0000000000000ffffff0000007fff00000000000007b4000',
  '00000000000007fffff0000003fff000000000e0007c1000', '00000000000007fffff0000003fff0000000000040060800',
  '00000000000003ffffe0000003fff8000000000004000000', '00000000000003ffffc0000003fff840000000000f300000',
  '00000000000001ffffc0000007fff8c0000000003e100000', '00000000000000ffffc0000007fff1c000000000ffb80000',
  '000000000000007fffc0000003ffc38000000000fff80000', '000000000000003fff80000003ff818000000003fffc0200',
  '000000000000003fff80000001ffc3800000000ffffe0000', '000000000000007ffe00000001ffc3000000001fffff0000',
  '000000000000007ff800000001ff00000000000fffff8000', '000000000000007ff800000001ff00000000000fffff8000',
  '000000000000007ff800000000ff00000000000fffff8000', '000000000000007ff000000000fe00000000000fffff8000',
  '000000000000007fe0000000007c000000000007e3ff0000', '000000000000007fe0000000007800000000000f81ff0000',
  '00000000000000ff000000000000000000000000007e0010', '00000000000000ff800000000000000000000000003e0008',
  '00000000000000ff0000000000000000000000000018000c', '00000000000000fc00000000000000000000000000000008',
  '00000000000000f0000000000000000000000000000c0018', '00000000000001f8000000000000000000000000000c0020',
  '00000000000000f000000000000000000000000000000060', '00000000000001e0000000000000000000000000000000c0',
  '00000000000001e000000000000000000000000000000000', '00000000000001f000000000000000000000000000000000',
  '00000000000001e000000000000000000800000000000000', '00000000000001c000000000000000000000000000000000',
  '00000000000001c100000000000000000000000000000000', '000000000000008000000000000000000000000000000000',
  '00000000000000e000000000000000000000000000000000', '000000000000007000000000000000000000000000000000',
];

/** Grid column and row of each hub, from the same projection as the land. */
const HUBS = {
  sanFrancisco: [29, 42], newYork: [55, 40], toronto: [52, 38], mexicoCity: [42, 53], bogota: [55, 61],
  saoPaulo: [70, 77], london: [94, 32], madrid: [92, 40], frankfurt: [99, 33], stockholm: [104, 25],
  lagos: [96, 60], nairobi: [114, 65], johannesburg: [109, 78], dubai: [124, 50], mumbai: [133, 54],
  singapore: [150, 63], hongKong: [155, 52], tokyo: [169, 44], seoul: [162, 42], sydney: [175, 83],
} satisfies Record<string, [number, number]>;

type Hub = keyof typeof HUBS;

const ROUTES: [Hub, Hub][] = [
  ['sanFrancisco', 'newYork'], ['newYork', 'london'], ['toronto', 'frankfurt'], ['sanFrancisco', 'mexicoCity'],
  ['mexicoCity', 'saoPaulo'], ['bogota', 'madrid'], ['saoPaulo', 'lagos'], ['frankfurt', 'stockholm'],
  ['madrid', 'lagos'], ['lagos', 'johannesburg'], ['london', 'dubai'], ['nairobi', 'dubai'],
  ['dubai', 'mumbai'], ['johannesburg', 'mumbai'], ['frankfurt', 'singapore'], ['mumbai', 'singapore'],
  ['singapore', 'hongKong'], ['hongKong', 'seoul'], ['seoul', 'tokyo'], ['singapore', 'sydney'], ['tokyo', 'sydney'],
];

/** Deterministic, so the map looks the same on every visit and every resize. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface LandDot {
  col: number;
  row: number;
  /** 0–1 brightness. */
  tone: number;
  violet: boolean;
}

const LAND: LandDot[] = [];
const SEA = new Set<number>();
{
  const random = seeded(7);
  for (let row = 0; row < MAP_ROWS; row += 1) {
    for (let col = 0; col < MAP_COLS; col += 1) {
      const nibble = parseInt(LAND_ROWS[row][col >> 2], 16);
      if (nibble & (8 >> (col & 3))) LAND.push({ col, row, tone: 0.55 + random() * 0.45, violet: random() < 0.13 });
      else SEA.add(row * MAP_COLS + col);
    }
  }
}

/** A sparse mesh over the land: a few dots, each joined to its two nearest neighbours. */
const MESH_NODES = (() => {
  const random = seeded(23);
  return LAND.filter(() => random() < 0.016);
})();
const MESH_EDGES: [LandDot, LandDot][] = (() => {
  const seen = new Set<string>();
  const edges: [LandDot, LandDot][] = [];
  MESH_NODES.forEach((node, i) => {
    MESH_NODES.map((other, j) => ({ j, d: Math.hypot(node.col - other.col, node.row - other.row) }))
      .filter(({ j, d }) => j !== i && d < 16)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
      .forEach(({ j }) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) return;
        seen.add(key);
        edges.push([node, MESH_NODES[j]]);
      });
  });
  return edges;
})();

/** Dots that brighten and fade on their own, out of step with each other. */
const TWINKLES = (() => {
  const random = seeded(41);
  return LAND.filter(() => random() < 0.025).map((dot) => ({ dot, speed: 0.6 + random() * 1.4, phase: random() * Math.PI * 2 }));
})();

interface Geometry {
  cell: number;
  x: number;
  y: number;
  mapWidth: number;
  mapHeight: number;
  /** Where the wall meets the floor. */
  floor: number;
}

function geometryFor(width: number, height: number): Geometry {
  // The map fills most of the height and runs off the sides, like a wall seen up close.
  const cell = Math.min((height * 0.8) / MAP_ROWS, (width * 1.5) / MAP_COLS);
  const mapWidth = cell * MAP_COLS;
  const mapHeight = cell * MAP_ROWS;
  const y = height * 0.43 - mapHeight / 2;
  return { cell, x: (width - mapWidth) * 0.3, y, mapWidth, mapHeight, floor: y + mapHeight + cell * 5 };
}

function point(geo: Geometry, col: number, row: number): [number, number] {
  return [geo.x + (col + 0.5) * geo.cell, geo.y + (row + 0.5) * geo.cell];
}

function offscreen(width: number, height: number, ratio: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return [canvas, context];
}

/** The land dots with their glow and the mesh. Transparent, so it can be mirrored onto the floor. */
function paintLand(ctx: CanvasRenderingContext2D, geo: Geometry) {
  const { cell } = geo;
  for (const dot of LAND) {
    const [x, y] = point(geo, dot.col, dot.row);
    ctx.fillStyle = dot.violet ? 'rgba(150, 120, 255, 0.07)' : 'rgba(70, 170, 255, 0.07)';
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.95, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const dot of LAND) {
    const [x, y] = point(geo, dot.col, dot.row);
    ctx.fillStyle = dot.violet ? `rgba(176, 150, 255, ${dot.tone})` : `rgba(96, 200, 255, ${dot.tone})`;
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.27, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.lineWidth = 0.6;
  ctx.strokeStyle = 'rgba(170, 205, 255, 0.28)';
  ctx.beginPath();
  for (const [a, b] of MESH_EDGES) {
    ctx.moveTo(...point(geo, a.col, a.row));
    ctx.lineTo(...point(geo, b.col, b.row));
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(225, 240, 255, 0.85)';
  for (const node of MESH_NODES) {
    const [x, y] = point(geo, node.col, node.row);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, cell * 0.22), 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The land in near-white, for the sweep that passes over it. */
function paintBright(ctx: CanvasRenderingContext2D, geo: Geometry) {
  ctx.fillStyle = 'rgba(200, 238, 255, 0.9)';
  for (const dot of LAND) {
    const [x, y] = point(geo, dot.col, dot.row);
    ctx.beginPath();
    ctx.arc(x, y, geo.cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Everything that does not move: the room, the screen, the land and its reflection. */
function paintBase(ctx: CanvasRenderingContext2D, land: HTMLCanvasElement, geo: Geometry, width: number, height: number) {
  const { cell, floor } = geo;
  const wallTop = geo.y - cell * 5;

  const room = ctx.createLinearGradient(0, 0, 0, height);
  room.addColorStop(0, '#02040c');
  room.addColorStop(Math.max(0, wallTop / height), '#050b20');
  room.addColorStop(Math.min(1, (geo.y + geo.mapHeight * 0.5) / height), '#08143a');
  room.addColorStop(Math.min(1, floor / height), '#060d26');
  room.addColorStop(1, '#03050f');
  ctx.fillStyle = room;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.55, geo.y + geo.mapHeight * 0.45, 0, width * 0.55, geo.y + geo.mapHeight * 0.45, width * 0.75);
  glow.addColorStop(0, 'rgba(45, 105, 230, 0.32)');
  glow.addColorStop(0.55, 'rgba(70, 60, 200, 0.12)');
  glow.addColorStop(1, 'rgba(20, 30, 90, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // The seams between the screen's panels.
  ctx.strokeStyle = 'rgba(150, 185, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const tile = (floor - wallTop) / 3;
  for (let x = geo.x; x < width; x += tile) {
    if (x <= 0) continue;
    ctx.moveTo(x, wallTop);
    ctx.lineTo(x, floor);
  }
  for (let y = wallTop; y <= floor + 0.5; y += tile) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // The screen's own pixel grid, faint over the sea.
  ctx.fillStyle = 'rgba(120, 160, 255, 0.09)';
  const speck = Math.max(0.8, cell * 0.12);
  for (const index of SEA) {
    const [x, y] = point(geo, index % MAP_COLS, Math.floor(index / MAP_COLS));
    ctx.fillRect(x - speck / 2, y - speck / 2, speck, speck);
  }

  ctx.drawImage(land, 0, 0, width, height);

  // The wall reflected on a polished floor, fading out towards the viewer.
  if (floor < height) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, floor, width, height - floor);
    ctx.clip();
    ctx.translate(0, floor * 2);
    ctx.scale(1, -1);
    ctx.globalAlpha = 0.2;
    ctx.drawImage(land, 0, 0, width, height);
    ctx.restore();

    const fade = ctx.createLinearGradient(0, floor, 0, height);
    fade.addColorStop(0, 'rgba(3, 6, 18, 0.15)');
    fade.addColorStop(1, 'rgba(3, 5, 15, 0.95)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, floor, width, height - floor);

    const horizon = ctx.createLinearGradient(0, 0, width, 0);
    horizon.addColorStop(0, 'rgba(110, 170, 255, 0)');
    horizon.addColorStop(0.5, 'rgba(110, 170, 255, 0.4)');
    horizon.addColorStop(1, 'rgba(110, 170, 255, 0)');
    ctx.fillStyle = horizon;
    ctx.fillRect(0, floor - 0.5, width, 1);
  }

  // The ceiling, falling off into shadow.
  const ceiling = ctx.createLinearGradient(0, 0, 0, Math.max(1, wallTop));
  ceiling.addColorStop(0, 'rgba(1, 2, 8, 0.85)');
  ceiling.addColorStop(1, 'rgba(1, 2, 8, 0)');
  ctx.fillStyle = ceiling;
  ctx.fillRect(0, 0, width, Math.max(0, wallTop));
}

function arcPoint(a: [number, number], b: [number, number], lift: number, p: number): [number, number] {
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2 - lift;
  const q = 1 - p;
  return [q * q * a[0] + 2 * q * p * cx + p * p * b[0], q * q * a[1] + 2 * q * p * cy + p * p * b[1]];
}

export default function AuthWorldMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const surface: HTMLCanvasElement = canvas;
    const ctx: CanvasRenderingContext2D = context;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let geo: Geometry | null = null;
    let base: HTMLCanvasElement | null = null;
    let bright: HTMLCanvasElement | null = null;
    let frame = 0;

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = surface.clientWidth;
      height = surface.clientHeight;
      if (width === 0 || height === 0) {
        geo = null;
        base = null;
        bright = null;
        stop();
        return;
      }
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

      geo = geometryFor(width, height);
      const [landCanvas, landCtx] = offscreen(width, height, ratio);
      paintLand(landCtx, geo);
      const [baseCanvas, baseCtx] = offscreen(width, height, ratio);
      paintBase(baseCtx, landCanvas, geo, width, height);
      const [brightCanvas, brightCtx] = offscreen(width, height, ratio);
      paintBright(brightCtx, geo);
      base = baseCanvas;
      bright = brightCanvas;
    }

    function draw(t: number) {
      if (!geo || !base || !bright || width === 0 || height === 0) return;
      const { cell } = geo;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(base, 0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      // A light sweep crossing the land, slowly, left to right.
      const sweep = geo.x - 160 + ((t / 11) % 1) * (geo.mapWidth + 320);
      for (const [half, alpha] of [[110, 0.14], [55, 0.2], [22, 0.28]] as const) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(sweep - half, 0, half * 2, geo.floor);
        ctx.clip();
        ctx.globalAlpha = alpha;
        ctx.drawImage(bright, 0, 0, width, height);
        ctx.restore();
      }

      for (const { dot, speed, phase } of TWINKLES) {
        const level = Math.max(0, Math.sin(t * speed + phase)) ** 4;
        if (level < 0.02) continue;
        const [x, y] = point(geo, dot.col, dot.row);
        ctx.fillStyle = `rgba(215, 245, 255, ${level * 0.9})`;
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }

      ROUTES.forEach(([from, to], index) => {
        const a = point(geo!, ...HUBS[from]);
        const b = point(geo!, ...HUBS[to]);
        const lift = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.3;
        const tint = index % 3 === 1 ? '178, 150, 255' : '110, 205, 255';

        ctx.strokeStyle = `rgba(${tint}, 0.22)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.quadraticCurveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - lift, ...b);
        ctx.stroke();

        // One packet per route: it crosses, then rests a moment before the next.
        const p = ((t * 0.16 + index * 0.37) % 1.45) / 1.1;
        if (p > 1) return;
        const tail = 0.16;
        for (let k = 1; k <= 8; k += 1) {
          const segmentStart = Math.max(0, p - (tail * k) / 8);
          const segmentEnd = Math.max(0, p - (tail * (k - 1)) / 8);
          if (segmentEnd <= segmentStart) continue;
          ctx.strokeStyle = `rgba(${tint}, ${0.75 * (1 - (k - 1) / 8)})`;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(...arcPoint(a, b, lift, segmentStart));
          ctx.lineTo(...arcPoint(a, b, lift, segmentEnd));
          ctx.stroke();
        }
        const [hx, hy] = arcPoint(a, b, lift, p);
        const head = ctx.createRadialGradient(hx, hy, 0, hx, hy, cell * 1.6);
        head.addColorStop(0, `rgba(${tint}, 0.95)`);
        head.addColorStop(1, `rgba(${tint}, 0)`);
        ctx.fillStyle = head;
        ctx.beginPath();
        ctx.arc(hx, hy, cell * 1.6, 0, Math.PI * 2);
        ctx.fill();
      });

      Object.values(HUBS).forEach(([col, row], index) => {
        const [x, y] = point(geo!, col, row);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, cell * 2.4);
        glow.addColorStop(0, 'rgba(140, 215, 255, 0.55)');
        glow.addColorStop(1, 'rgba(140, 215, 255, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, cell * 2.4, 0, Math.PI * 2);
        ctx.fill();

        const ring = (t * 0.42 + index * 0.29) % 1;
        ctx.strokeStyle = `rgba(150, 220, 255, ${0.55 * (1 - ring)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, cell * (0.8 + ring * 3.2), 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.4, cell * 0.36), 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.globalCompositeOperation = 'source-over';
    }

    function step(now: number) {
      draw(now / 1000);
      frame = requestAnimationFrame(step);
    }

    function start() {
      if (reduceMotion || frame || width === 0 || height === 0) return;
      frame = requestAnimationFrame(step);
    }

    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }

    function handleVisibility() {
      if (document.hidden) stop();
      else start();
    }

    // The still frame (reduced motion, and the moment before the loop starts) shows packets mid-flight.
    const STILL = 2.4;
    const observer = new ResizeObserver(() => {
      resize();
      draw(STILL);
      start();
    });
    observer.observe(surface);
    resize();
    draw(STILL);
    start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />;
}

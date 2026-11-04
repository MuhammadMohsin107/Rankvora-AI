import { useEffect, useRef, type CSSProperties } from 'react';
import { BrainCircuit } from 'lucide-react';

/**
 * The live background behind the sign-in pages: flowing light streams and a drifting node network
 * on a canvas, with the light form side on the right fading into it. Also the glass chart cards and
 * AI node (AuthInsightCards) that sit inside the map panel.
 *
 * Decorative only. Everything is aria-hidden, and the cards carry no numbers, dates or axes — they
 * are shapes, not data, so nothing here can be read as a figure about anyone's store.
 *
 * The canvas appears from `lg` up; below that the form sits on the light side alone. Under
 * prefers-reduced-motion one still frame is drawn and nothing moves. The loop pauses while the tab
 * is hidden.
 */

interface Stream {
  /** Vertical centre as a fraction of the height. */
  y: number;
  amp: number;
  freq: number;
  speed: number;
  phase: number;
  /** How far the stream climbs from left to right, as a fraction of the height. */
  tilt: number;
  color: string;
  glow: string;
  width: number;
}

const STREAMS: Stream[] = [
  { y: 0.28, amp: 34, freq: 0.0042, speed: 0.55, phase: 0, tilt: -0.16, color: 'rgba(96, 196, 255, 0.75)', glow: '120, 210, 255', width: 1.6 },
  { y: 0.34, amp: 50, freq: 0.0035, speed: 0.42, phase: 1.7, tilt: -0.2, color: 'rgba(124, 140, 255, 0.6)', glow: '150, 160, 255', width: 1.2 },
  { y: 0.42, amp: 42, freq: 0.0047, speed: 0.6, phase: 3.1, tilt: -0.18, color: 'rgba(90, 216, 255, 0.72)', glow: '120, 225, 255', width: 1.8 },
  { y: 0.48, amp: 30, freq: 0.0061, speed: 0.7, phase: 2.2, tilt: -0.19, color: 'rgba(170, 230, 255, 0.5)', glow: '190, 240, 255', width: 1 },
  { y: 0.55, amp: 58, freq: 0.0031, speed: 0.36, phase: 4.4, tilt: -0.22, color: 'rgba(155, 135, 255, 0.55)', glow: '175, 160, 255', width: 1.3 },
  { y: 0.62, amp: 36, freq: 0.0052, speed: 0.5, phase: 0.9, tilt: -0.17, color: 'rgba(96, 196, 255, 0.62)', glow: '120, 210, 255', width: 1.6 },
  { y: 0.7, amp: 46, freq: 0.004, speed: 0.4, phase: 2.5, tilt: -0.21, color: 'rgba(124, 140, 255, 0.5)', glow: '150, 160, 255', width: 1.2 },
  { y: 0.78, amp: 40, freq: 0.0045, speed: 0.48, phase: 3.8, tilt: -0.2, color: 'rgba(90, 216, 255, 0.48)', glow: '120, 225, 255', width: 1.4 },
  { y: 0.86, amp: 30, freq: 0.0058, speed: 0.66, phase: 5.2, tilt: -0.15, color: 'rgba(90, 216, 255, 0.42)', glow: '120, 225, 255', width: 1 },
];

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const LINK_DISTANCE = 140;

function streamY(stream: Stream, x: number, width: number, height: number, t: number): number {
  return (
    stream.y * height
    + (x / width - 0.5) * stream.tilt * height
    + Math.sin(x * stream.freq + t * stream.speed + stream.phase) * stream.amp
    + Math.sin(x * stream.freq * 0.47 - t * stream.speed * 0.6) * stream.amp * 0.6
  );
}

function NetworkCanvas() {
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
    let nodes: Node[] = [];
    let frame = 0;
    let last = 0;

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = surface.clientWidth;
      height = surface.clientHeight;
      // Hidden below `lg` (display: none), so there is nothing to draw and nothing to animate.
      if (width === 0 || height === 0) {
        nodes = [];
        stop();
        return;
      }
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.max(40, Math.min(110, Math.round((width * height) / 16000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: 0.8 + Math.random() * 1.6,
      }));
    }

    function draw(t: number) {
      if (width === 0 || height === 0) return;
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';

      for (const stream of STREAMS) {
        ctx.beginPath();
        for (let x = -20; x <= width + 20; x += 8) {
          const y = streamY(stream, x, width, height, t);
          if (x === -20) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = stream.color;
        ctx.lineWidth = stream.width;
        ctx.stroke();

        // Two sparks ride each stream, a half-width apart.
        for (let k = 0; k < 2; k += 1) {
          const span = width + 80;
          const x = ((t * 70 * stream.speed + k * span * 0.5 + stream.phase * 90) % span) - 40;
          const y = streamY(stream, x, width, height, t);
          const glow = ctx.createRadialGradient(x, y, 0, x, y, 9);
          glow.addColorStop(0, `rgba(${stream.glow}, 0.95)`);
          glow.addColorStop(1, `rgba(${stream.glow}, 0)`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(x, y, 9, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const distance = Math.hypot(dx, dy);
          if (distance < LINK_DISTANCE) {
            ctx.strokeStyle = `rgba(130, 165, 255, ${(1 - distance / LINK_DISTANCE) * 0.26})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      for (const node of nodes) {
        ctx.fillStyle = 'rgba(185, 210, 255, 0.85)';
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    function step(now: number) {
      // Frame-rate independent: movement scales with elapsed time, capped after a stall.
      const scale = last ? Math.min((now - last) / 16.67, 3) : 1;
      last = now;
      for (const node of nodes) {
        node.x += node.vx * scale;
        node.y += node.vy * scale;
        if (node.x < -10) node.x = width + 10;
        else if (node.x > width + 10) node.x = -10;
        if (node.y < -10) node.y = height + 10;
        else if (node.y > height + 10) node.y = -10;
      }
      draw(now / 1000);
      frame = requestAnimationFrame(step);
    }

    function start() {
      if (reduceMotion || frame || width === 0 || height === 0) return;
      last = 0;
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

    const observer = new ResizeObserver(() => {
      resize();
      draw(0);
      start();
    });
    observer.observe(surface);
    resize();
    draw(0);
    start();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />;
}

type ChartKind = 'line' | 'bars' | 'combo';

const LINE_PATH = 'M0 34 C 12 31, 20 37, 32 29 S 52 15, 66 21 S 92 9, 120 6';
const BAR_HEIGHTS = [14, 22, 18, 28, 20, 33, 26, 38, 31];

/** A chart shape with no values — see the component header. */
function MiniChart({ kind, id }: { kind: ChartKind; id: string }) {
  return (
    <svg viewBox="0 0 120 44" className="mt-2 h-11 w-full" fill="none">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(120, 190, 255, 0.45)" />
          <stop offset="1" stopColor="rgba(120, 190, 255, 0)" />
        </linearGradient>
      </defs>
      {kind !== 'line' &&
        BAR_HEIGHTS.map((barHeight, index) => (
          <rect
            key={index}
            x={4 + index * 13}
            y={42 - barHeight}
            width="7"
            height={barHeight}
            rx="1.5"
            fill={kind === 'bars' && index === 7 ? 'rgba(186, 170, 255, 0.95)' : 'rgba(140, 160, 255, 0.6)'}
          />
        ))}
      {kind !== 'bars' && (
        <>
          {kind === 'line' && <path d={`${LINE_PATH} L120 44 L0 44 Z`} fill={`url(#${id}-fill)`} />}
          <path d={LINE_PATH} stroke="rgba(150, 215, 255, 0.95)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="120" cy="6" r="2.4" fill="#ffffff" />
        </>
      )}
    </svg>
  );
}

function ChartCard({ title, kind, delay }: { title: string; kind: ChartKind; delay: string }) {
  return (
    <div
      className="auth-drift w-full rounded-xl border border-white/15 bg-[rgba(16,26,76,0.55)] p-3 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.7)] backdrop-blur-md"
      style={{ '--drift-delay': delay } as CSSProperties}
    >
      <p className="text-[10.5px] font-medium tracking-wide text-white/75">{title}</p>
      <MiniChart kind={kind} id={kind} />
    </div>
  );
}

/**
 * The column of chart cards with the AI node between them, set inside the map panel on the left.
 * The panel shows it from `xl` up, where there is room beside the copy.
 */
export function AuthInsightCards() {
  return (
    <div aria-hidden="true" className="pointer-events-none flex w-[156px] flex-none flex-col items-center gap-4">
      <ChartCard title="Store performance" kind="line" delay="0s" />
      <ChartCard title="Store checks" kind="bars" delay="-3s" />

      <div className="auth-drift relative flex h-[104px] w-[104px] items-center justify-center" style={{ '--drift-delay': '-1.5s' } as CSSProperties}>
        <span className="absolute inset-0 rounded-full border border-cyan-300/30 bg-[rgba(10,18,60,0.55)]" />
        <span className="auth-pulse absolute inset-0 rounded-full border border-cyan-300/50" />
        <span className="absolute inset-1 rounded-full bg-[radial-gradient(circle,rgba(110,170,255,0.38)_0%,rgba(110,170,255,0)_70%)]" />
        <BrainCircuit size={78} strokeWidth={0.9} className="relative text-white/85" />
        <span className="absolute flex h-8 w-8 items-center justify-center rounded-full bg-[#101a50] text-[12px] font-bold text-white ring-1 ring-white/50">
          AI
        </span>
      </div>

      <ChartCard title="Store charts" kind="combo" delay="-6s" />
    </div>
  );
}

export default function AuthBackdrop() {
  return (
    <div aria-hidden="true">
      <div className="fixed inset-0 z-0 hidden lg:block">
        <NetworkCanvas />
      </div>

      <div className="auth-light fixed inset-y-0 right-0 z-[1]" />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';

export type ChartSpec = {
  title: string; kind: 'bar' | 'line'; unit: '$' | '%' | ''; labels: string[];
  series: Array<{ name: string; values: Array<number | null> }>; caption?: string;
  /** Bars below zero in the "bad" color and above in "good" (for left over, shortfalls). */
  signed?: boolean;
};

const COLORS = ['var(--accent)', 'var(--warn)', 'var(--bad)', 'var(--good)'];
const W = 640, H = 250, L = 58, R = 12, T = 14, B = 34;

const fmtAxis = (v: number, unit: string) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (unit === '%') return `${s}${Math.round(a)}%`;
  const p = unit === '$' ? '$' : '';
  return a >= 1e6 ? `${s}${p}${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}${p}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `${s}${p}${Math.round(a)}`;
};
const fmtFull = (v: number, unit: string) =>
  unit === '%' ? `${v.toFixed(1)}%` : `${v < 0 ? '−' : ''}${unit === '$' ? '$' : ''}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: unit === '$' ? 2 : 0, maximumFractionDigits: 2 })}`;

function niceStep(range: number) {
  const raw = range / 4, mag = 10 ** Math.floor(Math.log10(raw || 1)), n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/** A bar or line chart in SVG that animates in the first time it scrolls into view. */
export function Chart({ spec }: { spec: ChartSpec }) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setShown(true); return; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setShown(true); io.disconnect(); } }, { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const vals = spec.series.flatMap(s => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!vals.length) return null;
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const y = (v: number) => T + (hi - v) / (hi - lo) * (H - T - B);
  const n = spec.labels.length, band = (W - L - R) / n;
  const x = (i: number) => L + band * (i + 0.5);
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  const every = Math.ceil(n / 8);
  const ns = spec.series.length, bw = Math.min(46, band * 0.72 / ns);

  return (
    <figure className={`chart ${shown ? 'in' : ''}`} ref={ref}>
      <figcaption className="charttitle">{spec.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${spec.title}. ${spec.caption ?? ''}`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className={t === 0 ? 'zero' : 'grid'} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" className="axis">{fmtAxis(t, spec.unit)}</text>
          </g>
        ))}
        {spec.labels.map((lab, i) => i % every === 0 && <text key={i} x={x(i)} y={H - 10} textAnchor="middle" className="axis">{lab}</text>)}
        {spec.kind === 'bar' ? spec.series.map((s, si) => s.values.map((v, i) => {
          if (v === null || !Number.isFinite(v)) return null;
          const bx = x(i) - (bw * ns) / 2 + si * bw, top = y(Math.max(v, 0)), h = Math.max(1, Math.abs(y(v) - y(0)));
          const fill = spec.signed ? (v < 0 ? 'var(--bad)' : 'var(--good)') : COLORS[si % COLORS.length];
          return (
            <rect key={`${si}-${i}`} className="bar" x={bx + 1} y={top} width={Math.max(2, bw - 2)} height={h} rx={3} fill={fill}
              style={{ transformOrigin: v < 0 ? `${bx}px ${y(0)}px` : `${bx}px ${y(0)}px`, animationDelay: `${(i * ns + si) * 45}ms` }}>
              <title>{`${spec.labels[i]} · ${s.name}: ${fmtFull(v, spec.unit)}`}</title>
            </rect>
          );
        })) : spec.series.map((s, si) => {
          const pts = s.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : [x(i), y(v), v] as const));
          const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), '');
          return (
            <g key={si}>
              <path d={d} className="line" pathLength={1} stroke={COLORS[si % COLORS.length]} style={{ animationDelay: `${si * 150}ms` }} />
              {pts.map((p, i) => p && (
                <circle key={i} cx={p[0]} cy={p[1]} r={3.5} fill={COLORS[si % COLORS.length]} className="pt" style={{ animationDelay: `${300 + i * 60}ms` }}>
                  <title>{`${spec.labels[i]} · ${s.name}: ${fmtFull(p[2], spec.unit)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      {ns > 1 && <div className="legend">{spec.series.map((s, i) => <span key={i}><i style={{ background: COLORS[i % COLORS.length] }} />{s.name}</span>)}</div>}
      {spec.caption && <p className="hnote chartcap">{spec.caption}</p>}
    </figure>
  );
}

import type { MortgageDetailResult } from '../engine/mortgageDetail';

type Props = {
  series: MortgageDetailResult[];
  colors: string[];
  metric?: 'realNetWorth' | 'principalRemaining';
};

export function MortgageDetailChart({
  series,
  colors,
  metric = 'realNetWorth',
}: Props) {
  const width = 960;
  const height = 420;
  const pad = { top: 28, right: 160, bottom: 44, left: 78 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const allPoints = series.flatMap((s) =>
    s.points
      .filter((p) =>
        metric === 'realNetWorth' ? p.year <= s.wealthHorizonYears : true,
      )
      .map((p) => p[metric]),
  );
  const minY = Math.min(0, ...allPoints);
  const maxY = Math.max(...allPoints, 1);
  const spanY = maxY - minY || 1;
  const maxYear = Math.max(
    ...series.map((s) => {
      const pts =
        metric === 'realNetWorth'
          ? s.points.filter((p) => p.year <= s.wealthHorizonYears)
          : s.points;
      return pts.at(-1)?.year ?? 0;
    }),
    1,
  );

  const x = (year: number) => pad.left + (year / maxYear) * innerW;
  const y = (value: number) =>
    pad.top + innerH - ((value - minY) / spanY) * innerH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => minY + spanY * t);
  const title =
    metric === 'principalRemaining'
      ? 'Остаток долга, ₽'
      : 'Реальный капитал, ₽ сегодня';

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title}
    >
      <text x={pad.left} y={18} fill="rgba(183,196,188,0.95)" fontSize="12">
        {title}
      </text>

      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(tick)}
            y2={y(tick)}
            stroke="rgba(243,239,230,0.1)"
          />
          <text
            x={pad.left - 10}
            y={y(tick) + 4}
            textAnchor="end"
            fill="rgba(183,196,188,0.9)"
            fontSize="12"
          >
            {formatCompact(tick)}
          </text>
        </g>
      ))}

      {Array.from({ length: maxYear + 1 }, (_, year) => (
        <text
          key={year}
          x={x(year)}
          y={height - 14}
          textAnchor="middle"
          fill="rgba(183,196,188,0.9)"
          fontSize="12"
        >
          {year === 0 ? 'сейчас' : `${year}г`}
        </text>
      ))}

      {series.map((result, i) => {
        const color = colors[i % colors.length];
        const pts =
          metric === 'realNetWorth'
            ? result.points.filter((p) => p.year <= result.wealthHorizonYears)
            : result.points;
        const d = pts
          .map(
            (pt, idx) =>
              `${idx === 0 ? 'M' : 'L'} ${x(pt.year).toFixed(1)} ${y(pt[metric]).toFixed(1)}`,
          )
          .join(' ');
        const last = pts[pts.length - 1];
        const shortLabel =
          result.label.length > 28
            ? `${result.label.slice(0, 26)}…`
            : result.label;
        return (
          <g key={result.id}>
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <text
              x={x(last.year) + 8}
              y={y(last[metric]) + 4}
              fill={color}
              fontSize="11"
              fontWeight="600"
            >
              {formatCompact(last[metric])}
            </text>
            <text
              x={pad.left + innerW + 8}
              y={pad.top + 18 + i * 18}
              fill={color}
              fontSize="11"
            >
              {shortLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function formatCompact(value: number): string {
  const sign = value < 0 ? '−' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)} млн`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)} тыс`;
  return `${sign}${Math.round(abs)}`;
}

import type { ScenarioResult } from '../engine/types';

type Props = {
  results: ScenarioResult[];
  colors: string[];
};

export function NetWorthChart({ results, colors }: Props) {
  const width = 960;
  const height = 460;
  const pad = { top: 24, right: 24, bottom: 40, left: 72 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const allPoints = results.flatMap((r) => r.years.map((y) => y.realNetWorth));
  const minY = Math.min(0, ...allPoints);
  const maxY = Math.max(...allPoints, 1);
  const spanY = maxY - minY || 1;
  const maxYear = Math.max(...results.map((r) => r.years.at(-1)?.year ?? 0), 1);

  const x = (year: number) => pad.left + (year / maxYear) * innerW;
  const y = (value: number) => pad.top + innerH - ((value - minY) / spanY) * innerH;

  function pathFor(result: ScenarioResult): string {
    return result.years
      .map(
        (pt, i) =>
          `${i === 0 ? 'M' : 'L'} ${x(pt.year).toFixed(1)} ${y(pt.realNetWorth).toFixed(1)}`,
      )
      .join(' ');
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => minY + spanY * t);

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="График реального капитала по годам — все сценарии"
    >
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
          y={height - 12}
          textAnchor="middle"
          fill="rgba(183,196,188,0.9)"
          fontSize="12"
        >
          {year === 0 ? 'сейчас' : `${year}г`}
        </text>
      ))}

      {results.map((result, i) => (
        <g key={result.scenarioId}>
          <path
            d={pathFor(result)}
            fill="none"
            stroke={colors[i % colors.length]}
            strokeWidth="3.2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {result.years.map((pt) => (
            <circle
              key={`${result.scenarioId}-${pt.year}`}
              cx={x(pt.year)}
              cy={y(pt.realNetWorth)}
              r="3.5"
              fill={colors[i % colors.length]}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}м`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)}к`;
  return `${Math.round(value)}`;
}

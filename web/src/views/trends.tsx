import type { TrendPoint } from '../lib/presentation'

const W = 360
const H = 160
const PAD_TOP = 22
const PAD_BOTTOM = 22

/** Balken je Monat, der laufende kräftig (wie SavingsRateChart der Mac-App). */
export function BarTrend({ points, label }: { points: TrendPoint[]; label: string }) {
  if (points.length === 0) return <p class="leise">Noch kein Verlauf.</p>
  const values = points.map((p) => p.value ?? 0)
  const max = Math.max(1, ...values.map(Math.abs))
  const step = W / points.length
  const base = H - PAD_BOTTOM
  const room = base - PAD_TOP
  return (
    <svg class="verlauf" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <line class="achse" x1={0} x2={W} y1={base} y2={base} />
      {points.map((p, i) => {
        const v = p.value ?? 0
        const h = (Math.abs(v) / max) * room
        const x = i * step + step * 0.2
        const y = v >= 0 ? base - h : base
        return (
          <g key={p.month}>
            {p.value !== null && (
              <rect
                class={`balken${p.isCurrent ? ' aktuell' : ''}${v < 0 ? ' negativ' : ''}`}
                x={x}
                y={y}
                width={step * 0.6}
                height={Math.max(1, h)}
                rx={3}
              >
                <title>{`${p.label}: ${p.text}`}</title>
              </rect>
            )}
            {p.isCurrent && (
              <text class="wert" x={x + step * 0.3} y={Math.max(12, y - 6)} text-anchor="middle">
                {p.text}
              </text>
            )}
            <text class="monat" x={x + step * 0.3} y={H - 6} text-anchor="middle">
              {p.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** Linie über die Monate; Lücken ohne Wert bleiben offen. */
export function LineTrend({
  points,
  label,
  tone,
}: {
  points: TrendPoint[]
  label: string
  tone: string
}) {
  const known = points.filter((p) => p.value !== null)
  if (known.length === 0) return <p class="leise">Noch kein Verlauf.</p>
  const values = known.map((p) => p.value as number)
  const min = Math.min(0, ...values)
  const max = Math.max(1, ...values)
  const step = points.length > 1 ? W / (points.length - 1) : 0
  const base = H - PAD_BOTTOM
  const room = base - PAD_TOP
  const xOf = (i: number) => (points.length > 1 ? i * step : W / 2)
  const yOf = (v: number) => base - ((v - min) / (max - min)) * room
  const segments: string[] = []
  let current = ''
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current) segments.push(current)
      current = ''
      return
    }
    current += `${current ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`
  })
  if (current) segments.push(current)
  const last = points.at(-1)
  return (
    <svg class={`verlauf ton-${tone}`} viewBox={`0 -4 ${W} ${H + 4}`} role="img" aria-label={label}>
      <line class="achse" x1={0} x2={W} y1={base} y2={base} />
      {segments.map((d) => (
        <path key={d} class="linie" d={d} />
      ))}
      {points.map((p, i) =>
        p.value === null ? null : (
          <circle
            key={p.month}
            class={`punkt${p.isCurrent ? ' aktuell' : ''}`}
            cx={xOf(i)}
            cy={yOf(p.value)}
            r={p.isCurrent ? 5 : 3}
          >
            <title>{`${p.label}: ${p.text}`}</title>
          </circle>
        ),
      )}
      {last && last.value !== null && (
        <text
          class="wert"
          x={Math.min(W - 4, xOf(points.length - 1))}
          y={Math.max(12, yOf(last.value) - 10)}
          text-anchor="end"
        >
          {last.text}
        </text>
      )}
      {points.map((p, i) => (
        <text
          key={`m${p.month}`}
          class="monat"
          x={Math.min(W - 14, Math.max(14, xOf(i)))}
          y={H - 4}
          text-anchor="middle"
        >
          {p.label}
        </text>
      ))}
    </svg>
  )
}

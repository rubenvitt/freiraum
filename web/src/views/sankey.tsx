import { useMemo } from 'preact/hooks'
import type { Flow, Household, PersonFlow } from '../api/client'
import { money } from '../lib/money'
import {
  labelLeading,
  layoutSankey,
  linkPath,
  type SankeyLayout,
  type SankeyNode,
} from '../lib/sankey'

const WIDTH = 1000
const LEFT = 220
const RIGHT = 220
/** Längere Namen werden gekürzt; der volle Name steht im Hinweis beim Überfahren. */
const MAX_LABEL = 28
const short = (label: string) =>
  label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label

type Tone = 'privat' | 'gemeinsam' | 'erstich' | 'warnung' | 'rest' | 'neutral'

/** Knoten-ID ohne vorangestellten Haushalt (Geldfluss einer Person: `<haushalt>/<knoten>`). */
const localId = (node: SankeyNode) =>
  node.householdId && node.id.startsWith(`${node.householdId}/`)
    ? node.id.slice(node.householdId.length + 1)
    : node.id

/** Farben wie in der Mac-App (SankeyView.swift): Violett privat, Blau gemeinsam, Grün Erst ich. */
function makeTones(kindOf: (node: SankeyNode | undefined) => Household['kind']) {
  const household = (node: SankeyNode | undefined): Tone =>
    kindOf(node) === 'gemeinsam' ? 'gemeinsam' : 'privat'
  const node = (n: SankeyNode): Tone => {
    switch (n.kind) {
      case 'haushalt':
        return household(n)
      case 'quelle':
        return localId(n) === 'quelle:erspartes' ? 'warnung' : household(n)
      case 'einzahlung':
        return 'gemeinsam'
      case 'gruppe':
        return 'neutral'
      case 'topf':
        return n.potKind === 'erst_ich' ? 'erstich' : 'neutral'
      case 'rest':
        return 'rest'
    }
  }
  const link = (layout: SankeyLayout, source: string, target: string): Tone => {
    const find = (id: string) => layout.nodes.find((n) => n.id === id)
    const s = find(source)
    const end = s?.kind === 'haushalt' ? find(target) : s
    if (!end) return household(undefined)
    if (end.kind === 'topf' && end.potKind === 'erst_ich') return 'erstich'
    if (localId(end) === 'quelle:erspartes') return 'warnung'
    if (end.kind === 'rest') return 'rest'
    if (end.kind === 'einzahlung') return 'gemeinsam'
    return household(end)
  }
  return { node, link }
}

export function Sankey({
  flow,
  household,
  households,
}: {
  flow: Flow | PersonFlow
  household: Household
  households: Household[]
}) {
  const across = 'personId' in flow
  const height = across ? 520 : 440
  const layout = useMemo(
    () => layoutSankey(flow, WIDTH - LEFT - RIGHT, height - 20, { nodeWidth: 14, nodePadding: 12 }),
    [flow, height],
  )
  const kinds = new Map(households.map((h) => [h.id, h.kind]))
  const tones = makeTones(
    (n) => (n?.householdId ? kinds.get(n.householdId) : undefined) ?? household.kind,
  )
  const labelOf = (id: string) => layout.nodes.find((n) => n.id === id)?.label ?? id

  return (
    <svg
      class="sankey"
      viewBox={`0 0 ${WIDTH} ${height}`}
      role="img"
      aria-label="Geldfluss als Sankey-Diagramm"
    >
      <g transform={`translate(${LEFT} 10)`}>
        {layout.links.map((l) => (
          <path
            key={`${l.source}→${l.target}`}
            class={`band ton-${tones.link(layout, l.source, l.target)}`}
            d={linkPath(l)}
          >
            <title>{`${labelOf(l.source)} → ${labelOf(l.target)}: ${money(l.valueCents)}`}</title>
          </path>
        ))}
        {layout.nodes.map((n) => {
          const leading = labelLeading(layout, n)
          const x = leading ? n.x0 - 10 : n.x1 + 10
          const y = (n.y0 + n.y1) / 2
          return (
            <g key={n.id}>
              <rect
                class={`knoten ton-${tones.node(n)}`}
                x={n.x0}
                y={n.y0}
                width={n.x1 - n.x0}
                height={Math.max(1, n.y1 - n.y0)}
                rx={4}
              >
                <title>{`${n.label}: ${money(n.valueCents)}`}</title>
              </rect>
              <text class="beschriftung" x={x} y={y - 2} text-anchor={leading ? 'end' : 'start'}>
                {short(n.label)}
              </text>
              <text class="betrag" x={x} y={y + 14} text-anchor={leading ? 'end' : 'start'}>
                {money(n.valueCents)}
              </text>
            </g>
          )
        })}
      </g>
    </svg>
  )
}

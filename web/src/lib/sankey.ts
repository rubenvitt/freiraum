// Layout eines Sankey-Diagramms für den Geldfluss, Port von Sankey.swift (FreiraumKit).
//
// Spalten ergeben sich aus dem längsten Weg von einer Quelle. Knoten ohne Ausgang (Töpfe,
// „Übrig“) stehen immer in der letzten Spalte. Alle Spalten teilen einen Maßstab (Pixel je Cent),
// damit gleiche Beträge gleich dick sind. Die Reihenfolge in einer Spalte ist die der API.
import type { FlowLink, FlowNode } from '../api/client'

export type FlowInput = {
  nodes: (FlowNode & { householdId?: string })[]
  links: FlowLink[]
}

export type SankeyNode = {
  id: string
  label: string
  kind: FlowNode['kind']
  potKind: FlowNode['potKind']
  /** nur im Geldfluss einer Person */
  householdId: string | null
  column: number
  /** Durchfluss: das Größere aus Zu- und Abfluss */
  valueCents: number
  x0: number
  x1: number
  y0: number
  y1: number
}

export type SankeyLink = {
  source: string
  target: string
  valueCents: number
  /** rechter Rand der Quelle */
  x0: number
  /** linker Rand des Ziels */
  x1: number
  sourceY0: number
  sourceY1: number
  targetY0: number
  targetY1: number
}

export type SankeyLayout = {
  width: number
  height: number
  nodes: SankeyNode[]
  links: SankeyLink[]
  columns: number
  /** Pixel je Cent */
  scale: number
}

const keyOf = (l: { source: string; target: string }) => `${l.source}\u0000${l.target}`

export function layoutSankey(
  flow: FlowInput,
  width: number,
  height: number,
  opts: { nodeWidth?: number; nodePadding?: number } = {},
): SankeyLayout {
  const nodeWidth = opts.nodeWidth ?? 14
  const nodePadding = opts.nodePadding ?? 12

  const known = new Set(flow.nodes.map((n) => n.id))
  const links = flow.links.filter(
    (l) => l.valueCents > 0 && l.source !== l.target && known.has(l.source) && known.has(l.target),
  )
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const l of links) {
    outgoing.set(l.source, (outgoing.get(l.source) ?? 0) + l.valueCents)
    incoming.set(l.target, (incoming.get(l.target) ?? 0) + l.valueCents)
  }
  // Knoten ohne jede Verbindung zeichnen wir nicht.
  const used = flow.nodes.filter((n) => incoming.has(n.id) || outgoing.has(n.id))

  // Spalte = längster Weg von einer Quelle; höchstens so viele Runden wie Knoten (Kreise).
  const depth = new Map<string, number>()
  for (const n of used) if (!depth.has(n.id)) depth.set(n.id, 0)
  for (let round = 0; round < Math.max(1, used.length); round++) {
    let changed = false
    for (const l of links) {
      const nextDepth = (depth.get(l.source) ?? 0) + 1
      if (nextDepth > (depth.get(l.target) ?? 0) && nextDepth < used.length) {
        depth.set(l.target, nextDepth)
        changed = true
      }
    }
    if (!changed) break
  }
  const last = Math.max(0, ...depth.values())
  for (const n of used) {
    if (!outgoing.has(n.id) && incoming.has(n.id)) depth.set(n.id, last)
  }
  const columns = used.length === 0 ? 0 : last + 1

  // Gemeinsamer Maßstab: die vollste Spalte füllt die Höhe.
  const value = (id: string) => Math.max(incoming.get(id) ?? 0, outgoing.get(id) ?? 0)
  const byColumn = Array.from({ length: columns }, (_, c) =>
    used.filter((n) => depth.get(n.id) === c),
  )
  let scale = Number.POSITIVE_INFINITY
  for (const column of byColumn) {
    if (column.length === 0) continue
    const sum = column.reduce((s, n) => s + value(n.id), 0)
    if (sum <= 0) continue
    const room = height - nodePadding * (column.length - 1)
    scale = Math.min(scale, Math.max(0, room) / sum)
  }
  if (!Number.isFinite(scale)) scale = 0

  const step = columns > 1 ? (width - nodeWidth) / (columns - 1) : 0
  const placed = new Map<string, SankeyNode>()
  const order: SankeyNode[] = []
  byColumn.forEach((column, c) => {
    const total =
      column.reduce((s, n) => s + value(n.id) * scale, 0) +
      nodePadding * Math.max(0, column.length - 1)
    let y = Math.max(0, (height - total) / 2)
    const x0 = c * step
    for (const n of column) {
      const h = value(n.id) * scale
      const placedNode: SankeyNode = {
        id: n.id,
        label: n.label,
        kind: n.kind,
        potKind: n.potKind,
        householdId: n.householdId ?? null,
        column: c,
        valueCents: value(n.id),
        x0,
        x1: x0 + nodeWidth,
        y0: y,
        y1: y + h,
      }
      placed.set(n.id, placedNode)
      order.push(placedNode)
      y += h + nodePadding
    }
  })

  // Bänder: an jedem Knoten von oben nach unten in der Reihenfolge der Gegenseite, damit sich
  // Bänder möglichst wenig kreuzen.
  const rank = new Map<string, number>()
  links.forEach((l, i) => {
    if (!rank.has(keyOf(l))) rank.set(keyOf(l), i)
  })
  const byPosition = (other: (l: FlowLink) => string) => (a: FlowLink, b: FlowLink) => {
    const ya = placed.get(other(a))?.y0 ?? 0
    const yb = placed.get(other(b))?.y0 ?? 0
    return ya !== yb ? ya - yb : (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0)
  }
  const startAt = new Map<string, [number, number]>()
  const endAt = new Map<string, [number, number]>()
  for (const n of order) {
    let offset = 0
    for (const l of links.filter((x) => x.source === n.id).sort(byPosition((x) => x.target))) {
      const h = l.valueCents * scale
      startAt.set(keyOf(l), [n.y0 + offset, n.y0 + offset + h])
      offset += h
    }
    offset = 0
    for (const l of links.filter((x) => x.target === n.id).sort(byPosition((x) => x.source))) {
      const h = l.valueCents * scale
      endAt.set(keyOf(l), [n.y0 + offset, n.y0 + offset + h])
      offset += h
    }
  }

  const laidOut: SankeyLink[] = []
  for (const l of links) {
    const s = placed.get(l.source)
    const t = placed.get(l.target)
    const start = startAt.get(keyOf(l))
    const end = endAt.get(keyOf(l))
    if (!s || !t || !start || !end) continue
    laidOut.push({
      source: l.source,
      target: l.target,
      valueCents: l.valueCents,
      x0: s.x1,
      x1: t.x0,
      sourceY0: start[0],
      sourceY1: start[1],
      targetY0: end[0],
      targetY1: end[1],
    })
  }

  return { width, height, nodes: order, links: laidOut, columns, scale }
}

/**
 * Band unter dem Zeiger (für den Hinweis beim Überfahren), oder null. Die Bänder sind kubische
 * Kurven mit beiden Kontrollpunkten auf halber Strecke; senkrecht verlaufen sie dann wie
 * `3s² − 2s³` (genähert, für einen Treffer reicht das).
 */
export function linkAt(layout: SankeyLayout, x: number, y: number): SankeyLink | null {
  for (let i = layout.links.length - 1; i >= 0; i--) {
    const l = layout.links[i]
    if (!l || l.x1 <= l.x0 || x < l.x0 || x > l.x1) continue
    const s = (x - l.x0) / (l.x1 - l.x0)
    const ease = s * s * (3 - 2 * s)
    const top = l.sourceY0 + (l.targetY0 - l.sourceY0) * ease
    const bottom = l.sourceY1 + (l.targetY1 - l.sourceY1) * ease
    if (y >= top && y <= bottom) return l
  }
  return null
}

/** Ob die Beschriftung links vom Knoten steht (erste Spalte) oder rechts. */
export const labelLeading = (layout: SankeyLayout, node: SankeyNode): boolean =>
  node.column === 0 && layout.columns > 1

/** SVG-Pfad eines Bands: oben hin, unten zurück, jeweils kubisch. */
export function linkPath(l: SankeyLink): string {
  const mid = (l.x0 + l.x1) / 2
  return (
    `M${l.x0},${l.sourceY0}C${mid},${l.sourceY0} ${mid},${l.targetY0} ${l.x1},${l.targetY0}` +
    `L${l.x1},${l.targetY1}C${mid},${l.targetY1} ${mid},${l.sourceY1} ${l.x0},${l.sourceY1}Z`
  )
}

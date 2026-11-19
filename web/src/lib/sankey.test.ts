// Port von SankeyTests.swift (FreiraumKit). Alle Namen und Beträge sind erfunden.
import { describe, expect, it } from 'vitest'
import { type FlowInput, labelLeading, layoutSankey, linkAt, linkPath } from './sankey'

type Kind = FlowInput['nodes'][number]['kind']
const node = (id: string, kind: Kind, label?: string) => ({
  id,
  label: label ?? id,
  kind,
  potId: null,
  potKind: null,
})
const link = (source: string, target: string, valueCents: number) => ({
  source,
  target,
  valueCents,
})

// Wie die API ihn liefert: Haushalt zuerst, Quellen, Gruppen mit Töpfen, Töpfe ohne Gruppe, Rest.
const sample: FlowInput = {
  nodes: [
    node('haushalt', 'haushalt', 'Ich'),
    node('quelle:1', 'quelle', 'Gehalt'),
    node('quelle:2', 'quelle', 'Nebenjob'),
    node('gruppe:1', 'gruppe', 'Wohnen'),
    node('topf:miete', 'topf', 'Miete'),
    node('topf:strom', 'topf', 'Strom'),
    node('topf:depot', 'topf', 'Depot'),
    node('rest:uebrig', 'rest', 'Übrig'),
  ],
  links: [
    link('quelle:1', 'haushalt', 300_000),
    link('quelle:2', 'haushalt', 50_000),
    link('haushalt', 'gruppe:1', 120_000),
    link('gruppe:1', 'topf:miete', 100_000),
    link('gruppe:1', 'topf:strom', 20_000),
    link('haushalt', 'topf:depot', 50_000),
    link('haushalt', 'rest:uebrig', 180_000),
  ],
}

const layout = layoutSankey(sample, 1000, 500, { nodeWidth: 14, nodePadding: 10 })
const byId = (id: string) => {
  const n = layout.nodes.find((x) => x.id === id)
  if (!n) throw new Error(`Knoten ${id} fehlt`)
  return n
}

describe('Sankey-Layout', () => {
  it('Spalten nach längstem Weg, Senken rechts', () => {
    expect(layout.columns).toBe(4)
    expect(byId('quelle:1').column).toBe(0)
    expect(byId('haushalt').column).toBe(1)
    expect(byId('gruppe:1').column).toBe(2)
    expect(byId('topf:miete').column).toBe(3)
    // Direkt am Haushalt, aber ohne Ausgang: ganz rechts wie die anderen Töpfe.
    expect(byId('topf:depot').column).toBe(3)
    expect(byId('rest:uebrig').column).toBe(3)
    expect(byId('quelle:1').x0).toBe(0)
    expect(byId('topf:miete').x1).toBe(1000)
    expect(labelLeading(layout, byId('quelle:1'))).toBe(true)
    expect(labelLeading(layout, byId('topf:miete'))).toBe(false)
  })

  it('gemeinsamer Maßstab füllt die vollste Spalte', () => {
    // Spalte 3: 350.000 Cent in vier Knoten, drei Abstände.
    const expected = (500 - 3 * 10) / 350_000
    expect(layout.scale).toBeCloseTo(expected, 12)
    const haushalt = byId('haushalt')
    expect(haushalt.y1 - haushalt.y0).toBeCloseTo(350_000 * expected, 9)
    const gehalt = byId('quelle:1')
    expect(gehalt.y1 - gehalt.y0).toBeCloseTo(300_000 * expected, 9)
    expect((haushalt.y0 + haushalt.y1) / 2).toBeCloseTo(250, 9)
  })

  it('Bänder schließen lückenlos an die Knoten an', () => {
    for (const n of layout.nodes) {
      const outs = layout.links
        .filter((l) => l.source === n.id)
        .sort((a, b) => a.sourceY0 - b.sourceY0)
        .map((l) => [l.sourceY0, l.sourceY1] as const)
      const ins = layout.links
        .filter((l) => l.target === n.id)
        .sort((a, b) => a.targetY0 - b.targetY0)
        .map((l) => [l.targetY0, l.targetY1] as const)
      for (const list of [outs, ins]) {
        if (list.length === 0) continue
        expect(list[0]![0]).toBeCloseTo(n.y0, 9)
        for (let i = 1; i < list.length; i++) expect(list[i - 1]![1]).toBeCloseTo(list[i]![0], 9)
      }
    }
    const miete = layout.links.find((l) => l.target === 'topf:miete')!
    expect(miete.sourceY1 - miete.sourceY0).toBeCloseTo(miete.targetY1 - miete.targetY0, 9)
    expect(miete.x0).toBe(byId('gruppe:1').x1)
    expect(miete.x1).toBe(byId('topf:miete').x0)
  })

  it('Reihenfolge in der Spalte wie von der API', () => {
    const [miete, strom, depot, rest] = [
      'topf:miete',
      'topf:strom',
      'topf:depot',
      'rest:uebrig',
    ].map(byId)
    expect(miete!.y1).toBeLessThan(strom!.y0)
    expect(strom!.y1).toBeLessThan(depot!.y0)
    expect(depot!.y1).toBeLessThan(rest!.y0)
    const fromHousehold = layout.links
      .filter((l) => l.source === 'haushalt')
      .sort((a, b) => a.sourceY0 - b.sourceY0)
      .map((l) => l.target)
    expect(fromHousehold).toEqual(['gruppe:1', 'topf:depot', 'rest:uebrig'])
  })

  it('Treffer beim Überfahren', () => {
    const gehalt = layout.links.find((l) => l.source === 'quelle:1')!
    expect(linkAt(layout, gehalt.x0 + 0.1, (gehalt.sourceY0 + gehalt.sourceY1) / 2)?.source).toBe(
      'quelle:1',
    )
    expect(linkAt(layout, gehalt.x1 - 0.1, (gehalt.targetY0 + gehalt.targetY1) / 2)?.source).toBe(
      'quelle:1',
    )
    expect(linkAt(layout, 5, 100)).toBeNull()
    expect(linkAt(layout, gehalt.x0 + 0.1, gehalt.sourceY0 - 1)).toBeNull()
    expect(linkAt(layout, -10, 100)).toBeNull()
    expect(linkAt(layout, 2000, 100)).toBeNull()
  })

  it('leerer Fluss und ungültige Kanten', () => {
    const empty = layoutSankey({ nodes: [node('haushalt', 'haushalt')], links: [] }, 800, 400)
    expect(empty.nodes).toEqual([])
    expect(empty.links).toEqual([])
    expect(empty.columns).toBe(0)

    const odd = layoutSankey(
      {
        nodes: [node('haushalt', 'haushalt'), node('quelle:1', 'quelle')],
        links: [
          link('quelle:1', 'haushalt', 1000),
          link('quelle:1', 'fehlt', 500),
          link('haushalt', 'haushalt', 10),
          link('quelle:1', 'haushalt', 0),
        ],
      },
      800,
      400,
    )
    expect(odd.links).toHaveLength(1)
    expect(odd.columns).toBe(2)
    expect(odd.nodes.find((n) => n.id === 'haushalt')?.x1).toBe(800)
  })

  it('Kreis läuft nicht endlos', () => {
    const loop = layoutSankey(
      {
        nodes: [node('a', 'quelle'), node('b', 'haushalt'), node('c', 'topf')],
        links: [link('a', 'b', 100), link('b', 'c', 100), link('c', 'b', 50)],
      },
      600,
      300,
    )
    expect(loop.nodes).toHaveLength(3)
    expect(loop.columns).toBeLessThanOrEqual(3)
  })

  it('zeichnet Bänder als kubische Kurve mit Kontrollpunkten auf halber Strecke', () => {
    const l = layout.links[0]!
    const mid = (l.x0 + l.x1) / 2
    expect(linkPath(l)).toBe(
      `M${l.x0},${l.sourceY0}C${mid},${l.sourceY0} ${mid},${l.targetY0} ${l.x1},${l.targetY0}` +
        `L${l.x1},${l.targetY1}C${mid},${l.targetY1} ${mid},${l.sourceY1} ${l.x0},${l.sourceY1}Z`,
    )
  })
})

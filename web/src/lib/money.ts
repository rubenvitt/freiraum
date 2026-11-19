// Beträge (ganze Cent) und Anteile (Basispunkte) als Text, wie in der Mac-App
// (FreiraumKit `Money` und `RatioText`): deutsch, Tausenderpunkt, Dezimalkomma, echtes Minus.

/** Typografisches Minus (U+2212), wie im Design. */
export const MINUS = '−'
const NB = ' '

function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/**
 * „−34,18 €“, „1.390 €“. Ganze Euro ohne Nachkommastellen, außer mit `exact`. Mit `sign`
 * bekommen positive Beträge ein „+“.
 */
export function money(cents: number, opts: { exact?: boolean; sign?: boolean } = {}): string {
  const magnitude = Math.abs(cents)
  const euros = Math.floor(magnitude / 100)
  const rest = magnitude % 100
  let text = grouped(euros)
  if (opts.exact || rest !== 0) text += `,${String(rest).padStart(2, '0')}`
  if (cents < 0) text = MINUS + text
  else if (opts.sign && cents > 0) text = `+${text}`
  return `${text}${NB}€`
}

/** 2834 → „28 %“, 50 → „0,5 %“, null → „–“. Unter 10 % mit einer Nachkommastelle. */
export function ratio(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return '–'
  const sign = bp < 0 ? MINUS : ''
  const magnitude = Math.abs(bp)
  if (magnitude < 1000) {
    const tenths = Math.floor((magnitude + 5) / 10)
    const text = tenths % 10 === 0 ? `${tenths / 10}` : `${Math.floor(tenths / 10)},${tenths % 10}`
    return `${sign}${text}${NB}%`
  }
  return `${sign}${Math.floor((magnitude + 50) / 100)}${NB}%`
}

/** Abstand zweier Anteile in Prozentpunkten: „+3 Punkte“, „−1 Punkt“, „gleich“. */
export function points(deltaBp: number): string {
  const p = Math.floor((Math.abs(deltaBp) + 50) / 100)
  if (p === 0) return 'gleich'
  const sign = deltaBp < 0 ? MINUS : '+'
  return `${sign}${p} ${p === 1 ? 'Punkt' : 'Punkte'}`
}

/** Anteil als Zahl in Prozent für Diagramme (2834 → 28,34). */
export const ratioValue = (bp: number): number => bp / 100

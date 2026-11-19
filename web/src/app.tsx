import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  ApiError,
  api,
  type Flow,
  type Household,
  type Person,
  type PersonFlow,
  unwrap,
} from './api/client'
import { currentMonth, monthName, next, previous, type YearMonth } from './lib/month'
import {
  type AnalyticsView,
  buildAnalytics,
  historyRange,
  PERIOD_TITLES,
  PERIODS,
  periodRange,
} from './lib/presentation'
import { Login } from './login'
import { fallbackAfterNotFound, mergeState, readState, type ViewState, writeState } from './state'
import { Sankey } from './views/sankey'
import { BarTrend, LineTrend } from './views/trends'

type Loaded = {
  key: string
  view: AnalyticsView
  flow: Flow
  personFlow: PersonFlow | null
}

const shortLabel = (h: Household) => (h.kind === 'privat' ? 'Ich' : 'Gemeinsam')

function loadKey(householdId: string, month: YearMonth, s: ViewState) {
  return `${householdId}|${month}|${s.zeitraum}|${s.fluss}`
}

async function loadAnalytics(
  household: Household,
  month: YearMonth,
  state: ViewState,
  person: Person,
  hasShared: boolean,
): Promise<Loaded> {
  const householdId = household.id
  const path = { householdId }
  const budget = unwrap(
    await api.GET('/v1/households/{householdId}/budget/{month}', {
      params: { path: { householdId, month } },
    }),
  )
  const start = budget.budgetStartMonth
  const range = periodRange(state.zeitraum, month, start)
  const history = historyRange(month, start)
  const across = state.fluss === 'person' && hasShared
  const [summary, hist, flow, anomalies, goals, ownership, personFlow] = await Promise.all([
    api.GET('/v1/households/{householdId}/analytics/metrics', {
      params: { path, query: range },
    }),
    api.GET('/v1/households/{householdId}/analytics/metrics', {
      params: { path, query: history },
    }),
    api.GET('/v1/households/{householdId}/analytics/flow', { params: { path, query: range } }),
    api.GET('/v1/households/{householdId}/analytics/anomalies', {
      params: { path, query: { month } },
    }),
    api.GET('/v1/households/{householdId}/analytics/goals', { params: { path } }),
    api.GET('/v1/households/{householdId}/analytics/ownership-costs', {
      params: { path, query: range },
    }),
    across
      ? api.GET('/v1/persons/{personId}/analytics/flow', {
          params: { path: { personId: person.id }, query: range },
        })
      : Promise.resolve(null),
  ])
  const flowData = unwrap(flow)
  return {
    key: loadKey(householdId, month, state),
    flow: flowData,
    personFlow: personFlow ? unwrap(personFlow) : null,
    view: buildAnalytics({
      summary: unwrap(summary),
      history: unwrap(hist),
      flow: flowData,
      anomalies: unwrap(anomalies).items,
      goals: unwrap(goals).items,
      ownership: unwrap(ownership),
    }),
  }
}

export function App() {
  const [person, setPerson] = useState<Person | null | undefined>(undefined)
  const [households, setHouseholds] = useState<Household[] | null>(null)
  const [state, setState] = useState<ViewState>(() => readState(location.search))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)

  /** 401 heißt: Sitzung weg, zurück zur Anmeldung. Alles andere wird gezeigt. */
  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      setPerson(null)
      setHouseholds(null)
      setLoaded(null)
      return
    }
    setError(err instanceof Error ? err.message : 'Unbekannter Fehler.')
  }, [])

  // Angemeldet? (erneuert dabei das Cookie)
  useEffect(() => {
    api
      .GET('/v1/me')
      .then((r) => setPerson(unwrap(r)))
      .catch(fail)
  }, [fail])

  useEffect(() => {
    if (!person) return
    api
      .GET('/v1/households')
      .then((r) => setHouseholds(unwrap(r).items))
      .catch(fail)
  }, [person, fail])

  const household = households?.find((h) => h.id === state.haushalt) ?? households?.[0] ?? null
  const month = state.monat ?? currentMonth(new Date())
  const hasShared = households?.some((h) => h.kind === 'gemeinsam') ?? false

  const update = useCallback((patch: Partial<ViewState>) => {
    setState((s) => {
      const nextState = mergeState(s, patch)
      if (nextState !== s) {
        history.replaceState(null, '', `${location.pathname}${writeState(nextState)}`)
      }
      return nextState
    })
  }, [])

  // Unbekannter Haushalt in der Adresse (z. B. altes Lesezeichen): auf den ersten wechseln.
  useEffect(() => {
    if (household && state.haushalt && household.id !== state.haushalt) {
      update({ haushalt: household.id })
    }
  }, [household, state.haushalt, update])

  useEffect(() => {
    if (!person || !household) return
    let cancelled = false
    setLoading(true)
    setError(null)
    loadAnalytics(household, month, state, person, hasShared)
      .then((result) => {
        if (!cancelled) setLoaded(result)
      })
      .catch((err) => {
        if (cancelled) return
        // Nicht gefunden: einmal auf den ersten Haushalt wechseln, sonst Meldung zeigen und stehen
        // bleiben (kein erneutes Laden mit demselben Ergebnis).
        const fallback =
          err instanceof ApiError && err.status === 404 && households
            ? fallbackAfterNotFound(household.id, households)
            : null
        if (fallback) update({ haushalt: fallback })
        fail(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // reloads erzwingt ein neues Laden mit demselben Zustand.
  }, [person, household, month, state, hasShared, households, fail, update, reloads])

  async function logout() {
    setError(null)
    try {
      const { response } = await api.POST('/v1/auth/logout')
      // 401: Sitzung ohnehin weg. Alles andere heißt: Das Cookie gilt noch.
      if (!response.ok && response.status !== 401) throw new Error(String(response.status))
    } catch {
      setError('Abmelden hat nicht geklappt. Die Sitzung gilt noch; versuch es noch einmal.')
      return
    }
    setPerson(null)
    setHouseholds(null)
    setLoaded(null)
  }

  if (person === undefined) {
    return (
      <main class="laden">
        {error ? (
          <>
            <p class="meldung warnung" role="alert">
              {error}
            </p>
            <button type="button" class="leicht" onClick={() => location.reload()}>
              Neu laden
            </button>
          </>
        ) : (
          'Freiraum lädt …'
        )}
      </main>
    )
  }
  if (person === null) return <Login onLogin={setPerson} />

  const view = household && loaded?.key === loadKey(household.id, month, state) ? loaded : null

  return (
    <div class="seite">
      <header class="kopf">
        <p class="marke">Freiraum</p>
        <nav class="steuerung" aria-label="Auswahl">
          {households && households.length > 1 && (
            <fieldset class="segmente">
              <legend class="unsichtbar">Haushalt</legend>
              {households.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  aria-pressed={h.id === household?.id}
                  onClick={() => update({ haushalt: h.id })}
                >
                  {shortLabel(h)}
                </button>
              ))}
            </fieldset>
          )}
          <fieldset class="monat">
            <legend class="unsichtbar">Monat</legend>
            <button
              type="button"
              aria-label="Voriger Monat"
              onClick={() => update({ monat: previous(month) })}
            >
              ‹
            </button>
            <span>{`${monthName(month)} ${month.slice(0, 4)}`}</span>
            <button
              type="button"
              aria-label="Nächster Monat"
              onClick={() => update({ monat: next(month) })}
            >
              ›
            </button>
          </fieldset>
          <fieldset class="segmente">
            <legend class="unsichtbar">Zeitraum</legend>
            {PERIODS.map((p) => (
              <button
                type="button"
                key={p}
                aria-pressed={state.zeitraum === p}
                onClick={() => update({ zeitraum: p })}
              >
                {PERIOD_TITLES[p]}
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            class="leicht"
            onClick={() => setReloads((n) => n + 1)}
            disabled={loading}
          >
            {loading ? 'Lädt …' : 'Aktualisieren'}
          </button>
          <button type="button" class="leicht" onClick={logout}>
            Abmelden
          </button>
        </nav>
      </header>

      <main class="inhalt">
        {error && (
          <p class="meldung warnung" role="alert">
            {error}
          </p>
        )}
        {!household && households && <p class="leise">Für dich gibt es noch keinen Haushalt.</p>}
        {household && !view && !error && <p class="leise">Auswertung lädt …</p>}
        {household && view && (
          <Content
            loaded={view}
            household={household}
            households={households ?? []}
            month={month}
            across={state.fluss === 'person' && hasShared}
            hasShared={hasShared}
            onFlowScope={(fluss) => update({ fluss })}
          />
        )}
      </main>
    </div>
  )
}

function Content({
  loaded,
  household,
  households,
  month,
  across,
  hasShared,
  onFlowScope,
}: {
  loaded: Loaded
  household: Household
  households: Household[]
  month: YearMonth
  across: boolean
  hasShared: boolean
  onFlowScope: (fluss: ViewState['fluss']) => void
}) {
  const { view } = loaded
  const flow = across ? loaded.personFlow : loaded.flow
  return (
    <>
      <section class="titel">
        <p class="leise">{`${view.periodTitle} · ${shortLabel(household)}`}</p>
        <h1>
          {household.kind === 'gemeinsam'
            ? 'Woher kommt euer Geld, wohin fließt es?'
            : 'Woher kommt dein Geld, wohin fließt es?'}
        </h1>
      </section>

      <section class="kacheln">
        {view.tiles.map((t) => (
          <article key={t.id} class={`kachel ton-${t.tone}`}>
            <h2>{t.title}</h2>
            <p class="zahl">
              {t.value}
              {t.unit && <span class="einheit"> {t.unit}</span>}
            </p>
            <p class="detail">{t.detail}</p>
          </article>
        ))}
      </section>

      <section class="karte">
        <header>
          <h2>Geldfluss</h2>
          <p class="leise">{across ? 'Einkommen → Ich → Gemeinsam' : view.flowSummary}</p>
        </header>
        {hasShared && (
          <fieldset class="segmente">
            <legend class="unsichtbar">Geldfluss</legend>
            <button type="button" aria-pressed={!across} onClick={() => onFlowScope('haushalt')}>
              {`Nur ${shortLabel(household)}`}
            </button>
            <button type="button" aria-pressed={across} onClick={() => onFlowScope('person')}>
              Über meine Haushalte
            </button>
          </fieldset>
        )}
        {flow && flow.links.length > 0 ? (
          <Sankey flow={flow} household={household} households={households} />
        ) : (
          <p class="leise">Im Zeitraum gibt es noch keine zugeordneten Buchungen.</p>
        )}
        {view.uncategorizedNote && <p class="hinweis warnung">{view.uncategorizedNote}</p>}
      </section>

      <section class="raster">
        <article class="karte">
          <header>
            <h2>Sparquote im Verlauf</h2>
            <p class="leise">bis zu 12 Monate</p>
          </header>
          <BarTrend points={view.savingsRate} label="Sparquote je Monat" />
        </article>
        <article class="karte">
          <header>
            <h2>Fixkosten am Einkommen</h2>
          </header>
          <LineTrend
            points={view.fixedCostShare}
            label="Fixkostenanteil je Monat"
            tone="gemeinsam"
          />
        </article>
        <article class="karte">
          <header>
            <h2>Alter des Geldes</h2>
            <p class="leise">Tage am Monatsende</p>
          </header>
          <LineTrend points={view.ageOfMoney} label="Alter des Geldes je Monat" tone="good" />
        </article>
        <article class="karte">
          <header>
            <h2>{`Auffällig im ${monthName(month)}`}</h2>
          </header>
          {view.anomalies.length === 0 && <p class="leise">Nichts Auffälliges.</p>}
          <ul class="liste">
            {view.anomalies.map((a) => (
              <li key={a.id}>
                <span class="marke-klein">{a.badge}</span>
                {a.title}
              </li>
            ))}
          </ul>
        </article>
        <article class="karte">
          <header>
            <h2>Ziele</h2>
          </header>
          {view.goals.length === 0 && <p class="leise">Noch keine Ziel-Töpfe.</p>}
          <ul class="liste">
            {view.goals.map((g) => (
              <li key={g.id} class="ziel">
                <div class="zeile">
                  <strong>{g.name}</strong>
                  <span class="leise">{g.amount}</span>
                </div>
                <progress
                  class={g.onTrack ? `ton-${household.kind}` : 'ton-warning'}
                  max={1}
                  value={g.progress}
                  aria-label={`${g.name}: ${Math.round(g.progress * 100)} %`}
                />
                <p class="detail">{g.detail}</p>
              </li>
            ))}
          </ul>
        </article>
        <article class="karte">
          <header>
            <h2>Besitzkosten</h2>
            <p class="leise">{view.periodTitle}</p>
          </header>
          {view.assets.length === 0 && (
            <p class="leise">
              Noch kein Besitz angelegt. Ein Besitz bündelt die Töpfe seiner laufenden Kosten.
            </p>
          )}
          {view.assetSummary && <p class="leise">{view.assetSummary}</p>}
          <ul class="liste">
            {view.assets.map((a) => (
              <li key={a.id}>
                <div class="zeile">
                  <strong>{a.name}</strong>
                  <span>{a.cost}</span>
                </div>
                <p class="detail">
                  <span class={`marke-klein ${a.isLiability ? 'ton-warning' : 'ton-good'}`}>
                    {a.classification}
                  </span>
                  {a.detail}
                </p>
                {a.valueNote && <p class="detail">{a.valueNote}</p>}
                {a.pots.length > 0 && <p class="detail leise">{a.pots.join(' · ')}</p>}
              </li>
            ))}
          </ul>
        </article>
      </section>
    </>
  )
}

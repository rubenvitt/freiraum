# ADR 0003: Budget-Kern und Kategorisierung (E2)

Stand: 17.11.2026 · Status: vorgeschlagen (mit FREI-3)

## Kontext

Die Spec legt das Topf-Prinzip fest („jeder Euro bekommt eine Aufgabe“), die Topf-Typen
`monatlich`, `rücklage`, `ziel` und `erst_ich`, die Formel „Verfügbar = Übertrag + Zuweisung −
Ausgaben“ und die Invariante „Noch ohne Aufgabe ≥ 0“. Offen blieben: was mit überzogenen Töpfen
passiert, wie Zuweisungen in künftigen Monaten zählen, was ein Monatsabschluss bewirkt, wann die
Erst-ich-Automatik läuft und ob Vorschläge schon vor der Bestätigung im Budget zählen.

## Entscheidungen

### Rechnung: aus der Historie, als reine Funktion

`backend/src/budget/compute.ts` rechnet jeden Monat aus allen Zuweisungen und Aufteilungen des
Haushalts neu. Nichts wird fortgeschrieben, deshalb gibt es keine Salden, die auseinanderlaufen
können. Bei zwei Personen ist die Datenmenge klein; wird es langsam, lassen sich abgeschlossene
Monate später zwischenspeichern.

- **Verfügbar** im Topf = Übertrag + Zuweisung + Aufteilungen des Monats (Ausgaben negativ,
  Erstattungen positiv).
- **Übertrag** = Verfügbar des Vormonats, aber **nie negativ**. Ein überzogener Topf startet im
  Folgemonat bei 0; die Überziehung mindert stattdessen „Noch ohne Aufgabe“ **ab dem
  Folgemonat**. Im laufenden Monat bleibt sie im Topf sichtbar (rot), damit man umschichten kann.
- **Noch ohne Aufgabe (M)** = Einnahmen bis M − Zuweisungen bis M − **Zuweisungen nach M** −
  Überziehung der Monate vor M. Geld, das schon für einen späteren Monat verplant ist, ist auch
  heute vergeben.
- **Einnahme** ist eine Aufteilung der Art `einnahme`; sie fließt in „Noch ohne Aufgabe“ des
  Haushalts. **Umbuchung** (zwischen eigenen Konten desselben Haushalts) wirkt nicht aufs Budget.

### Invariante „Noch ohne Aufgabe ≥ 0“

Geprüft wird beim **Erhöhen** einer Zuweisung im Monat M, und zwar in M und im laufenden Monat,
falls dieser später liegt. So wird weder Geld eines späteren Monats rückwirkend verteilt noch
heute vorhandenes Geld doppelt vergeben. **Senken geht immer**, auch wenn der Wert durch
Überziehung schon negativ ist; sonst käme man aus einem negativen Stand nicht mehr heraus.
Schreibende Vorgänge sperren die Haushaltszeile, damit parallele Änderungen die Prüfung nicht
unterlaufen.

Die Summe der Aufteilungen = Buchungsbetrag und „Topf gehört zum Haushalt des Kontos“ prüft
zusätzlich ein Constraint-Trigger in der Datenbank (am Ende der Transaktion).

### Plan je Topf-Typ

| Typ | Planfelder | Plan für Monat M |
|---|---|---|
| `monatlich` | `amountCents` je Monat (optional) | `amountCents` |
| `ruecklage` | `amountCents` je Jahr | ein Zwölftel, aufgerundet |
| `ziel` | `amountCents` Zielbetrag, `targetMonth` (optional) | Rest bis zum Ziel ÷ Monate bis einschließlich Zielmonat, aufgerundet; ab dem Zielmonat der ganze Rest |
| `erst_ich` | `amountCents` je Monat **oder** `percentBp` | fester Betrag oder Anteil der Einnahmen des Monats (abgerundet) |

`neededCents` = Plan − Zuweisung (nie negativ). Der Plan weist nichts von selbst zu, außer bei
`erst_ich`.

### Erst-ich-Automatik

Läuft nach jeder Änderung der Einnahmen eines Monats (neue Vorschläge beim Import, Bestätigung,
Korrektur, LLM-Vorschlag), nach dem Anlegen oder Ändern eines Erst-ich-Topfs und auf Wunsch per
`POST …/budget/{month}/erst-ich`. Sie füllt die Erst-ich-Töpfe in ihrer Reihenfolge bis zum Plan,
soweit „Noch ohne Aufgabe“ reicht, und **rechnet ihre eigenen Beträge jedes Mal neu** (fällt eine
Einnahme weg, sinkt die Zuweisung). Weist eine Person einem Erst-ich-Topf in einem Monat selbst
zu, gehört der Wert ihr (`manuell`), und die Automatik lässt diesen Topf in diesem Monat in Ruhe.
Abgeschlossene Monate rührt sie nicht an.

### Monatsabschluss

- Nur vergangene Monate, **der Reihe nach**, und nur, wenn alle Buchungen des Monats bestätigt
  sind (das ist die „Monatsrunde zu zweit“).
- Danach nimmt der Monat **keine Zuweisungen** mehr an. Der Stand (Zusammenfassung und Töpfe)
  wird als Schnappschuss gespeichert.
- Buchungen eines abgeschlossenen Monats lassen sich weiter zuordnen: Banken buchen manchmal
  verspätet, und ein Import darf nie scheitern. Die Wirkung landet über den Übertrag im offenen
  Monat; der Schnappschuss zeigt, wie es beim Abschluss aussah.
- Zurücknehmen geht nur für den zuletzt abgeschlossenen Monat.

### Kategorisierung

- **Regeln greifen zuerst.** Merkmale: Konto, Richtung, Gegenpartei-IBAN, Gegenpartei-Name
  (gleich, ohne Groß-/Kleinschreibung), Teilstring im Verwendungszweck, Betragsspanne. Alle
  gesetzten Merkmale müssen passen; es gewinnt die spezifischste Regel, bei Gleichstand die
  zuletzt geänderte.
- **Ohne Treffer fragt ein LLM** (falls angebunden) mit Datum, Betrag, Gegenpartei-Name und
  Verwendungszweck, **ohne IBAN** (auch IBANs im Verwendungszweck werden vorher maskiert), und
  bekommt nur die Töpfe des Haushalts, zu dem das Konto gehört. Antworten mit unbekanntem Topf
  werden verworfen. Jede Buchung wird höchstens einmal beantwortet. Der Aufruf läuft nach dem
  Commit des Imports im Hintergrund, nie in einer offenen Transaktion; der Import wartet nicht
  darauf (FREI-16).
- **Gebündelt und begrenzt parallel** (FREI-16). Eine Anfrage trägt bis zu 20 Buchungen eines
  Haushalts (nie Buchungen verschiedener Haushalte zusammen, weil die Töpfe je Haushalt gelten),
  höchstens 3 Anfragen laufen gleichzeitig. 1.000 neue Buchungen ohne Regeltreffer sind damit
  50 Anfragen statt 1.000. LLM-Läufe stehen in einer Warteschlange und laufen nacheinander, damit
  Import-Nachlauf und Nachholen keine Buchung doppelt fragen.
- **Modell über OpenRouter** (Entscheidung 17.11.2026, FREI-14). Der Adapter
  (`backend/src/categorize/openrouter.ts`) spricht die OpenAI-kompatible Chat-Completions-
  Schnittstelle mit JSON-Schema (je Buchung ein Eintrag mit Buchung, Option, Konfidenz 0–100 und
  Begründung in einem Satz). Buchungen und Optionen tragen kurze Kennungen (`b1`, `o1`, …),
  Buchungs- und Topf-IDs verlassen den Server nicht. Jede Anfrage
  verlangt Anbieter ohne Datenspeicherung (`provider.data_collection: deny`, standardmäßig auch
  `zdr`) und mit Unterstützung aller Parameter. Welches Modell, legt `LLM_MODEL` fest; die
  Basis-URL ist austauschbar, ein lokales Modell mit derselben Schnittstelle ginge ohne
  Codeänderung. Ohne `LLM_API_KEY` bleibt das LLM aus.
  - Abgewogen: Ein lokales Modell hielte die Daten im Homelab, braucht aber passende Hardware und
    liefert bei deutschen Verwendungszwecken schwächere Ergebnisse. Über OpenRouter verlassen
    Gegenpartei und Verwendungszweck das Homelab, dafür gibt es gute Modelle für Cent-Beträge und
    die Wahl lässt sich ohne Code ändern.
- **Ausfall des Modells hält nichts auf.** Fehler und Zeitüberschreitung (`LLM_TIMEOUT_MS`, je
  Anfrage, Standard 60 s) lassen alle Buchungen der Anfrage `importiert` und ungefragt; nach drei
  gescheiterten Anfragen in Folge bricht der Lauf ab. Der Server holt solche Buchungen beim Start
  und alle 15 Minuten nach (nur die der letzten 7 Tage, damit das Einschalten des LLM nicht die
  ganze Historie abfragt; bis zu 1.000 je Durchgang). Eine unbrauchbare oder fehlende Antwort zu
  einer Buchung gilt dagegen als beantwortet, die übrigen Antworten der Anfrage zählen.
- **Vorschläge zählen sofort im Budget.** Ein Vorschlag legt gleich die Aufteilung an (Status
  `vorgeschlagen`). Sonst stünde das Gehalt erst nach der Bestätigung in „Noch ohne Aufgabe“,
  und die Erst-ich-Automatik liefe nicht „nach jedem Gehaltseingang“. Die Bestätigung ist ein
  Tipp; erst `bestaetigt` zählt für den Monatsabschluss.
- **Korrektur wird Regel.** Ordnet eine Person eine Buchung einem einzigen Ziel zu, das vom
  Vorschlag abweicht (oder es gab keinen), entsteht eine Regel aus Richtung und Gegenpartei
  (IBAN, sonst Name). Gleiche Merkmale lenken eine bestehende Regel um. Danach werden alle offenen
  Buchungen des Haushalts neu vorgeschlagen. Ohne Gegenpartei (z. B. Depotbank ohne Angaben)
  entsteht keine Regel; Aufteilungen auf mehrere Töpfe lernen nichts.

### Budgetbeginn und Anfangsbestand (FREI-13)

- Jeder Haushalt hat einen **Startmonat** (`households.budget_start_month`). Neue Haushalte
  starten im laufenden Monat. Davor zählt nichts im Budget: keine Einnahmen, keine Ausgaben,
  keine Zuweisungen, keine Überziehung. Import, Serienerkennung und spätere Auswertungen behalten
  die Buchungen. Monate vor dem Start sind im Budget leer.
- Der **Anfangsbestand** ist die Summe der Kontostände des Haushalts zu Beginn des Startmonats.
  Er wird nicht gespeichert, sondern aus einem **bekannten Kontostand** je Konto abgeleitet (Stand
  am Ende eines Stichtags, von Hand oder vom Anbieter): Stand − Buchungen ab Monatsbeginn bis zum
  Stichtag (+ Buchungen zwischen Stichtag und Start, falls der Stichtag davor liegt). Banken
  liefern den heutigen Saldo, nicht den zum Start; so bleibt der Wert richtig, wenn der Start
  verschoben wird oder später ältere Buchungen nachkommen. Konten ohne Kontostand zählen mit 0
  und sind in `GET …/budget-start` erkennbar.
- Der Anfangsbestand fließt im Startmonat in „Noch ohne Aufgabe“, ist aber **keine Einnahme des
  Monats**: Erst-ich-Töpfe mit Anteil rechnen nur mit echten Einnahmen. Feste Erst-ich-Beträge
  dürfen ihn nutzen.
- Erst-ich-Automatik, Zuweisungen und Monatsabschluss gelten erst ab dem Startmonat; der
  Abschluss „der Reihe nach“ beginnt dort. Regeln und LLM schlagen nur für Buchungen ab dem
  Start vor, `pending` listet nur diese.
- Den Start **verschieben** geht nur, solange kein Monat abgeschlossen ist und vor dem neuen Start
  keine eigene Zuweisung ≠ 0 liegt; Automatik- und 0-Zuweisungen davor werden entfernt. Rückt der
  Start nach vorn, bekommen die hinzukommenden Buchungen Vorschläge wie beim Import. Nach jeder
  Änderung von Start oder Kontostand läuft Erst-ich für alle offenen Monate ab dem Start bis heute.

### Haushaltsgrenzen

Töpfe kommen aus dem Haushalt des Kontos. Private Konten dürfen seit E4 auch Töpfe des
gemeinsamen Haushalts verwenden (Ausgleich), siehe [ADR 0006](0006-paar-modell.md).

## Folgen

- **Budgetbeginn** (FREI-13): Eine volle Historie ändert „Noch ohne Aufgabe“ nur ab dem
  Startmonat. Der Abruf beim Anbieter (FREI-12) speichert den Saldo mit
  `BudgetService.recordBalance(…, 'anbieter')`; bis dahin wird der Kontostand von Hand erfasst.
- Der Anfangsbestand hängt an vollständigen Buchungen zwischen Start und Stichtag. Fehlen dort
  Umsätze (Lücke im Import), ist er um genau diese Summe falsch; ein Stichtag nahe am Start hält
  das klein.
- LLM-Vorschläge erscheinen nach dem Import mit etwas Verzögerung (Sekunden bis Minuten bei
  großen Importen). Wer direkt nach dem Import die offenen Buchungen abruft, sieht einen Teil
  noch ohne Vorschlag. Die Warteschlange lebt im Prozess: Ein Neustart verliert sie, das
  Nachholen beim Start fängt das auf.
- Der zeitgesteuerte Abruf (FREI-12) bekommt Kategorisierung und Erst-ich ohne Zusatzarbeit, weil
  sie an `LedgerService.importTransactions` hängen.

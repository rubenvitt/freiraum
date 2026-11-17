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
  Verwendungszweck, **ohne IBAN**, und bekommt nur die Töpfe des Haushalts, zu dem das Konto
  gehört. Antworten mit unbekanntem Topf werden verworfen. Jede Buchung wird höchstens einmal
  gefragt. Der Aufruf läuft nach dem Commit des Imports, nie in einer offenen Transaktion.
- **Vorschläge zählen sofort im Budget.** Ein Vorschlag legt gleich die Aufteilung an (Status
  `vorgeschlagen`). Sonst stünde das Gehalt erst nach der Bestätigung in „Noch ohne Aufgabe“,
  und die Erst-ich-Automatik liefe nicht „nach jedem Gehaltseingang“. Die Bestätigung ist ein
  Tipp; erst `bestaetigt` zählt für den Monatsabschluss.
- **Korrektur wird Regel.** Ordnet eine Person eine Buchung einem einzigen Ziel zu, das vom
  Vorschlag abweicht (oder es gab keinen), entsteht eine Regel aus Richtung und Gegenpartei
  (IBAN, sonst Name). Gleiche Merkmale lenken eine bestehende Regel um. Danach werden alle offenen
  Buchungen des Haushalts neu vorgeschlagen. Ohne Gegenpartei (z. B. Depotbank ohne Angaben)
  entsteht keine Regel; Aufteilungen auf mehrere Töpfe lernen nichts.

### Haushaltsgrenzen

Töpfe kommen immer aus dem Haushalt des Kontos. Eine private Ausgabe für einen gemeinsamen Topf
(Ausgleich) kommt mit E4 (FREI-5).

## Folgen

- Es fehlt ein **Budgetbeginn**: Wer die volle Historie importiert, bekommt alle alten Einnahmen
  in „Noch ohne Aufgabe“, und die Automatik füllt alte Monate. Vor dem echten Einsatz braucht
  jeder Haushalt einen Startmonat mit Anfangsbestand (Folgeaufgabe, hängt an den Kontoständen
  aus FREI-12).
- Das LLM ist nur eine Schnittstelle (`backend/src/categorize/llm.ts`). Welches Modell, lokal oder
  per API, bleibt offen (Spec, „Offene Entscheidungen“).
- Der zeitgesteuerte Abruf (FREI-12) bekommt Kategorisierung und Erst-ich ohne Zusatzarbeit, weil
  sie an `LedgerService.importTransactions` hängen.

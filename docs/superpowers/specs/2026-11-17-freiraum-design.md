# Freiraum – Design-Spec

Stand: 17.11.2026 · Status: Entwurf · Zunder-Projekt: `FREI`

## Ziel

Freiraum ist ein persönliches Finanz-Cockpit für ein Paar mit getrennten Konten und einem gemeinsamen Konto. Es verbindet Budgetierung nach dem Topf-Prinzip („jeder Euro bekommt eine Aufgabe“) mit eigenen Geldregeln und detaillierten Auswertungen. Es soll mit möglichst wenig Pflegeaufwand möglichst viel Übersicht und Wirkung bringen.

Design-Entwurf: https://claude.ai/artifact/Uioh2erQiqv4nLqFDVfp6P

## Prinzipien

1. **Jeder Euro bekommt eine Aufgabe.** Verteilt wird nur Geld, das da ist, nicht erwartetes.
2. **Erst sich selbst bezahlen.** Nach jedem Gehaltseingang werden zuerst die „Erst ich“-Töpfe (Investieren, langfristige Rücklagen) gefüllt, automatisch.
3. **Vermögenswert ohne Gewinn = Verbindlichkeit.** Besitz wird mit seinen laufenden Kosten sichtbar gemacht.
4. **Wenig Pflege.** Ziel: höchstens 5 Minuten pro Woche (Buchungen bestätigen) plus eine Monatsrunde zu zweit. Alles, was die App selbst wissen kann, fragt sie nicht ab.
5. **Privatsphäre in der Beziehung.** Jede Person sieht vom privaten Haushalt der anderen nur, was diese freigibt. Durchgesetzt wird das auf dem Server, nicht in der Oberfläche.
6. **Zahlen im Mittelpunkt.** Modernes, ruhiges Design; Farbe nur mit Bedeutung.

## Plattformen

| Plattform | Rolle | Etappe |
|---|---|---|
| Backend | Bankimport, Kategorisierung, Budget-Logik, Sync, Autorisierung | E0–E2 |
| iOS (SwiftUI) | Übersicht, Buchungen bestätigen, Barausgaben erfassen, Widget, Benachrichtigungen | E3 |
| macOS (SwiftUI Multiplatform) | Planen, Töpfe umschichten, Auswertungen, Menüleiste | E5 |
| Web | Zugang ohne Installation, zunächst nur Auswertungen | E6, später |

Beide Personen nutzen iPhones, deshalb ist Web nicht Teil des ersten Wurfs.

### Technik

Festgelegt in [ADR 0001](../../adr/0001-technik-grundgeruest.md) (E0, FREI-1), für die Apps in [ADR 0004](../../adr/0004-ios-app.md) (E3, FREI-4). Ursprünglicher Vorschlag:

- Backend: TypeScript (z. B. Hono) + PostgreSQL, als Container auf dem Homelab (ARM64).
- API-Vertrag: OpenAPI als Quelle der Wahrheit; Swift-Client per `swift-openapi-generator`, Web-Client generiert.
- Apps: SwiftUI Multiplatform, Swift Charts, WidgetKit; lokaler Cache für schnellen Start, Server bleibt führend.
- Anmeldung: Passkeys oder Sign in with Apple (zwei Nutzer, kein öffentliches Sign-up).

## Datenmodell (fachlich)

Beträge immer als ganze Cent (Integer), Währung EUR.

- **Person**: Nutzerkonto.
- **Haushalt**: `privat` (genau eine Person) oder `gemeinsam` (beide). Je Person ein privater Haushalt, dazu ein gemeinsamer.
- **Konto**: gehört einem Haushalt. Quelle: `bank` (importiert), `bar`, `manuell`. Bankkonten tragen die Verbindung zum Anbieter.
- **Buchung**: Betrag, Datum, Gegenpartei, Verwendungszweck, Quell-ID der Bank. Status: `importiert` → `vorgeschlagen` → `bestätigt`.
- **Aufteilung**: ordnet eine Buchung einem oder mehreren Töpfen zu, je mit Haushalt und Betrag. Summe der Aufteilungen = Buchungsbetrag.
- **Topf**: gehört einem Haushalt. Typ: `monatlich` (z. B. Lebensmittel), `rücklage` (unregelmäßige Kosten, Monatsrate aus Jahresbetrag), `ziel` (Zielbetrag und Zieldatum), `erst_ich` (wird zuerst gefüllt). Gruppen zur Ordnung.
- **Zuweisung**: Betrag für Topf und Monat. Verfügbar im Topf = Übertrag aus dem Vormonat + Zuweisung − Ausgaben.
- **Einzahlungsregel**: wie viel eine Person ins Gemeinsame gibt: fester Betrag oder Prozent vom Netto.
- **Ausgleich**: entsteht, wenn eine Buchung von einem privaten Konto einem gemeinsamen Topf zugeordnet wird. Wird erledigt, sobald eine passende Überweisung erkannt oder manuell verbucht wird.
- **Freigabe**: Person A gibt Person B eine Kennzahl oder Sicht frei (z. B. Sparquote, „Erst ich erledigt“, Rücklagen gedeckt). Ohne Freigabe sieht B nichts aus A's privatem Haushalt.
- **Regel**: Kategorisierungsregel (Muster auf Gegenpartei, Verwendungszweck, Betrag, Konto → Topf und Haushalt).
- **Vorschlag**: Topf-Vorschlag zu einer Buchung mit Quelle (`regel` oder `llm`), Konfidenz und Begründung in einem Satz.
- **Wiederkehrend**: erkannte Serien (Abos, Miete, Gehalt) für Abo-Radar und Prognosen.

Rechenregeln für Übertrag, Überziehung, Plan je Topf-Typ, Erst-ich-Automatik, Monatsabschluss und Kategorisierung: [ADR 0003](../../adr/0003-budget-kern.md).

### Invarianten

- Zuweisungen eines Monats übersteigen nie das verfügbare Geld des Haushalts („Noch ohne Aufgabe“ ≥ 0).
- Summe der Aufteilungen = Betrag der Buchung.
- Bankimport ist idempotent (Quell-ID, sonst Hash aus Konto, Datum, Betrag, Verwendungszweck).
- Daten aus einem privaten Haushalt verlassen den Server an die andere Person nur über eine Freigabe.

## Bankanbindung

Optionen, in einem Spike (E1) zu bewerten:

- **FinTS direkt**: ohne Drittanbieter, bankabhängig, TAN-Verfahren aufwendig.
- **PSD2-Anbieter** (z. B. Enable Banking; GoCardless Bank Account Data: prüfen, ob noch neue Nutzer aufgenommen werden): einfacher, aber Abhängigkeit und Zustimmung alle 90–180 Tage.

Kriterien: alle eigenen Banken abgedeckt, Kosten, Aufwand der regelmäßigen Zustimmung, Datenschutz. Ergebnis des Spikes: [ADR 0002](../../adr/0002-bankanbindung.md).

## Kategorisierung mit wenig Pflege

1. Regeln greifen zuerst.
2. Ohne Treffer schlägt ein LLM Topf und Haushalt vor, mit Begründung.
3. Die Person bestätigt auf dem iPhone mit einem Tipp; Korrekturen werden zu neuen Regeln.
4. Bargeld: Abhebung wird als „Bargeld, noch nicht erfasst“ markiert, bis Barausgaben dagegen gebucht sind. Stand E3: Abhebung als Umbuchung zuordnen, Barausgaben im Bargeldkonto erfassen (ADR 0004); den offenen Bestand zeigt die App noch nicht.

## Auswertungen

- Geldfluss als Sankey: Einkommen → Haushalte → Töpfe, filterbar nach Haushalt und Zeitraum
- Sparquote (Monat, Verlauf, Ziel)
- Fixkostenanteil am Einkommen
- Runway: Monate ohne Einkommen bei heutigen Ausgaben
- Alter des Geldes
- Auffälligkeiten (Abweichung vom Schnitt, neue Abos)
- Ziele mit Prognose des Erreichens
- Besitzkosten („Was kostet mich mein Besitz?“)

Definitionen, Schwellen und das Datenmodell für Besitz: [ADR 0005](../../adr/0005-auswertungen.md).

## Etappen

- **E0 Grundgerüst**: Repo, Technik festlegen, Backend-Skelett, Datenbank, Anmeldung, Deployment aufs Homelab.
- **E1 Bank-Spike und Import**: Anbieter wählen, Import mit Idempotenz, wiederkehrende Buchungen erkennen.
- **E2 Budget-Kern**: Töpfe, Zuweisungen, Übertrag, Monatsabschluss, Automatik „Erst ich“.
- **E3 iOS-App**: Übersicht, Bestätigen, Barausgabe erfassen, Widget, Benachrichtigung „Buchungen warten“.
- **E4 Paar-Modell**: gemeinsamer Haushalt, Einzahlungsregeln, Ausgleich, Freigaben.
- **E5 Auswertungen und macOS**: Sankey, Kennzahlen, Verlauf, macOS-Ziel inkl. Menüleiste.
- **E6 Web**: Auswertungen im Browser.

## Öffentliches Repo

Das Repo ist öffentlich. Deshalb: keine echten Finanzdaten, Kontonamen oder Zugangsdaten im Repo; Secrets nur über Umgebungsvariablen; Testdaten sind erfunden.

## Offene Entscheidungen

- ~~Backend-Sprache und Framework~~: TypeScript + Hono, siehe ADR 0001
- ~~Bankanbieter~~: Enable Banking für alle Konten, siehe [ADR 0002](../../adr/0002-bankanbindung.md)
- ~~Welches LLM für Vorschläge, lokal oder per API~~: OpenRouter, Modell per Konfiguration, siehe [ADR 0003](../../adr/0003-budget-kern.md)
- Standard-Einzahlungsregel fürs Gemeinsame

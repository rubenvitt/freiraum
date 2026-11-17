# ADR 0005: Auswertungen und Besitz (E5)

Stand: 17.11.2026 · Status: vorgeschlagen (mit FREI-6)

## Kontext

Die Spec nennt für E5 acht Auswertungen: Geldfluss als Sankey, Sparquote, Fixkostenanteil,
Runway, Alter des Geldes, Auffälligkeiten, Ziele mit Prognose und Besitzkosten. Sie sagt nicht,
wie die Zahlen definiert sind. Die Definitionen müssen zu den Prinzipien passen: Erst-ich ist
Sparen, nicht Ausgeben; Umbuchungen sind neutral; was die App selbst wissen kann, fragt sie nicht
ab. Für Besitzkosten fehlt bisher ein Datenmodell.

## Entscheidungen

### Rechnung im Backend, als reine Funktionen

`backend/src/analytics/compute.ts` rechnet aus Buchungen, Aufteilungen, Töpfen und Serien eines
Haushalts. Nichts wird gespeichert, jede Anfrage rechnet neu (zwei Personen, kleine Mengen; wird
es langsam, lassen sich Monatswerte später zwischenspeichern). Die Apps (macOS, iOS, später Web)
zeichnen nur. So gibt es eine einzige Definition jeder Kennzahl, und die Privatsphäre-Grenze
bleibt auf dem Server: Jede Auswertung ist je Haushalt und nur für seine Mitglieder (sonst 404).

### Grundbegriffe

| Begriff | Definition |
|---|---|
| Einkommen | Summe der Einnahme-Aufteilungen. Nicht zugeordnete Eingänge zählen **nicht** (könnten Umbuchungen oder Erstattungen sein) und werden getrennt ausgewiesen. |
| Konsum | Ausgaben aus Töpfen außer Erst-ich, abzüglich Erstattungen, **plus nicht zugeordnete Ausgänge**. Lieber eine zu niedrige Sparquote als eine geschönte. |
| Erst ich | Ausgaben aus Erst-ich-Töpfen (z. B. Überweisung aufs Depot). Das ist Sparen, kein Konsum. |
| Einzahlung | vom privaten Konto ins Gemeinsame (ADR 0006): kein Konsum aus eigenen Töpfen, aber auch **nicht gespart**. Auf dem gemeinsamen Konto zählt sie als Einkommen. |
| Gespart | Einkommen − Konsum − Einzahlungen (enthält Erst ich und was auf den Konten bleibt). |
| Umbuchung | zählt nirgends. |
| Ausgleich | zählt nirgends, ebenso der Anteil einer privaten Buchung in einem gemeinsamen Topf: Das ist eine Forderung ans Gemeinsame, kein eigener Konsum (ADR 0006). |

Anteile kommen als **Basispunkte** (10 000 = 100 %), ohne Einkommen als `null` statt einer
Division durch null.

### Kennzahlen

- **Sparquote** = Gespart ÷ Einkommen, je Monat und für den Zeitraum. Ergänzt mit FREI-19:
  Einzahlungen ins Gemeinsame mindern die private Sparquote. Was das Gemeinsame davon zurücklegt,
  zeigt die Sparquote des gemeinsamen Haushalts; die private Quote soll nicht schöner aussehen,
  nur weil das Geld ein Konto weiter liegt. Erst-ich bleibt Sparen.
- **Fixkostenanteil** = Fixkosten ÷ Einkommen. Fixkosten sind der Konsum-Anteil von Ausgängen, die
  zu einer erkannten Serie gehören (Miete, Versicherungen, Abos). Ein Sparplan ist eine Serie,
  aber keine Fixkost.
- **Runway** = Geld des Haushalts ÷ durchschnittlicher Konsum der letzten bis zu 6
  abgeschlossenen Monate. Das Geld kommt aus dem Budget („Noch ohne Aufgabe“ + Zuweisungen
  späterer Monate + Verfügbar aller Töpfe) plus nicht zugeordnete Buchungen. Erst-ich zählt nicht
  zum Konsum: Ohne Einkommen würde man nicht weiter sparen. Wie im Budget zählt alles ab dem
  Budgetbeginn; was davor lag, steckt im Anfangsbestand (FREI-13).
  Ergänzt mit FREI-27: Im privaten Haushalt zählen **feste Einzahlungen ins Gemeinsame** als
  laufender Abfluss, Runway = Geld ÷ (Konsum + feste Einzahlungen). Es gilt je gemeinsamem
  Haushalt die Regel, die im laufenden Monat gilt (ADR 0006). Eine feste Einzahlung läuft auch
  ohne Einkommen weiter, eine Regel „Prozent vom Netto“ fällt dann weg und zählt nicht. Gerechnet
  wird mit der Regel, nicht mit den gebuchten Einzahlungen der Vergangenheit: Der Runway fragt,
  was ab jetzt abfließt. Ohne Konsum-Historie gibt es weiterhin keinen Runway, auch wenn eine
  feste Einzahlung bekannt ist; ein Wert nur aus den Einzahlungen wäre geschönt. Im gemeinsamen
  Haushalt ist die Einzahlung Einkommen und ändert den Runway nicht.
- **Alter des Geldes** (wie bei YNAB): Eingänge bilden eine Warteschlange, jeder Ausgang
  verbraucht die ältesten zuerst. Das Alter eines Ausgangs ist der mit dem Betrag gewichtete
  Abstand in Tagen; die Kennzahl ist der Durchschnitt der letzten 10 Ausgänge. Ausgänge ohne
  bekannten Eingang (Geld von vor dem ersten Import) bekommen kein Alter. Je Monat wird der Wert
  am Monatsende gezeigt, so entsteht der Verlauf.

### Geldfluss (Sankey)

Quellen → Haushalt → Gruppen → Töpfe. Quellen sind die Gegenparteien der Einnahmen (die größten
fünf, der Rest als „Weitere Einnahmen“), dazu „Erstattungen“ (Töpfe mit mehr Erstattungen als
Ausgaben) und „Nicht zugeordnete Eingänge“. Töpfe ohne Gruppe hängen direkt am Haushalt. Die Mitte
ist immer ausgeglichen: Fließt mehr hinaus als hinein, kommt der Rest „Aus Erspartem“, sonst
bleibt er „Übrig“. Die API liefert Knoten und Kanten, gezeichnet wird in der App.

Ein Sankey über mehrere Haushalte (privat → Einzahlung → gemeinsam) hängt an den
Einzahlungsregeln aus E4 und kommt danach.

### Auffälligkeiten

Je Monat, mit festen Schwellen (Konstanten in `compute.ts`):

- **Ausgaben hoch:** ein Monats-Topf (`monatlich`) liegt mindestens beim 1,5-Fachen des
  Durchschnitts der letzten 6 Monate **und** mindestens 50 € darüber. Es braucht mindestens 3
  Monate Historie. Rücklagen und Ziele werden geplant unregelmäßig geleert und sind ausgenommen.
- **Neues Abo:** eine aktive ausgehende Serie, die in diesem Monat zum ersten Mal erkennbar ist
  (ihre Buchungen bis Monatsende erreichen genau die Mindestzahl ihres Rhythmus). Eine feste
  Frist („erste Buchung höchstens 3 Monate her“) hätte jährliche und quartalsweise Abos nie
  gemeldet.
- **Preis erhöht:** die letzte Buchung einer laufenden Serie liegt im Monat und ist mindestens 3 %
  und 1 € teurer als die vorige.

### Ziele mit Prognose

Für jeden Ziel-Topf: gespart = Verfügbar im laufenden Monat, Sparrate = durchschnittliche
Zuweisung der letzten 3 Monate (mit dem laufenden), Prognose = laufender Monat + Rest ÷ Rate
(aufgerundet). Status `erreicht`, `im_plan`, `verspaetet` (Prognose nach dem Zielmonat) oder
`ohne_sparrate`. Dazu „monatlich nötig“, um den Zielmonat zu halten. Die Rate kommt aus den
Zuweisungen, nicht aus dem Plan: Die Prognose soll zeigen, was tatsächlich passiert.

### Besitz und Besitzkosten

Neue Tabellen `assets` (Name, optional aktueller Wert) und `asset_pots`. Ein Besitz bündelt die
Töpfe, aus denen seine laufenden Kosten kommen (z. B. Auto: Kfz-Versicherung, Werkstatt, Sprit).
Ein Topf gehört höchstens zu einem Besitz und nur zu einem aus demselben Haushalt (Constraint und
Trigger in der Datenbank).

Besitzkosten im Zeitraum (Standard: letzte 12 Monate) = Nettoausgaben der verknüpften Töpfe,
davon wiederkehrend, Monatsschnitt, Jahreskosten im Verhältnis zum Wert und Anteil am Konsum.
Nach dem Prinzip „Vermögenswert ohne Gewinn = Verbindlichkeit“ heißt ein Besitz mit Kosten
`verbindlichkeit`, einer mit Überschuss `vermoegenswert`.

Verworfen: Besitz über Gruppennamen der Töpfe ableiten. Gruppen dienen der Ordnung im Budget, und
ein Umbenennen würde still die Auswertung ändern.

## Folgen

- Einnahmen aus Besitz (z. B. Miete einer vermieteten Wohnung) gehen als Einnahme in „Noch ohne
  Aufgabe“ und sind keinem Besitz zugeordnet. Damit ist heute jeder Besitz mit Kosten eine
  Verbindlichkeit. Eine Zuordnung von Einnahmen zu Besitz ist eine Folgeaufgabe, falls sie
  gebraucht wird.
- Vor dem Budgetbeginn werden Buchungen nicht zugeordnet. Kennzahlen für diese Monate zeigen
  deshalb kein Einkommen und alle Ausgänge als „nicht zugeordnet“. Aussagekräftig sind die
  Auswertungen ab dem Budgetbeginn; die Apps sollten den Zeitraum dort beginnen lassen.
- Die Sparquote ist seit FREI-19 als Freigabe `sparquote` für die andere Person abrufbar
  (`GET /v1/persons/{id}/metrics/{JJJJ-MM}`), nur als ganzer Prozentwert (abgerundet), ohne
  Beträge.
- Fixkostenanteil und Sankey rechnen Einzahlungen ins Gemeinsame noch nicht mit: Im Sankey
  landet die Einzahlung privat unter „Übrig“ und fehlt im Gemeinsamen als Quelle. Das Sankey über
  Haushalte hinweg ist FREI-22. Der Runway rechnet feste Einzahlungen seit FREI-27 mit.
- Eine noch nicht zugeordnete Überweisung ins Gemeinsame zählt im Runway doppelt: als Konsum
  (nicht zugeordnet gilt als ausgegeben) und über die feste Regel. Das ist vorsichtig gerechnet
  und verschwindet, sobald die Buchung als Einzahlung zugeordnet ist.
- Die macOS-App (Menüleiste, Planungsansicht, Charts) baut auf diesen Endpunkten auf und folgt,
  sobald das Xcode-Projekt aus E3 (FREI-4) steht.

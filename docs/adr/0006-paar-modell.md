# ADR 0006: Paar-Modell (E4)

Stand: 17.11.2026 · Status: vorgeschlagen (mit FREI-5, ergänzt mit FREI-18 und FREI-28)

## Kontext

Die Spec sieht drei Haushalte vor (je Person ein privater, dazu ein gemeinsamer), Einzahlungsregeln
fürs Gemeinsame („fest oder Prozent vom Netto“), einen Ausgleich, wenn eine private Buchung einem
gemeinsamen Topf zugeordnet wird, und Freigaben: Ohne Freigabe sieht eine Person nichts aus dem
privaten Haushalt der anderen, durchgesetzt auf dem Server. Offen blieben: wie Geld zwischen den
Haushalten im Budget zählt, woran der Server erkennt, wer eingezahlt hat, wann ein Ausgleich
erledigt ist und was eine Freigabe genau öffnet.

## Entscheidungen

### Zwei neue Arten der Aufteilung

| Art | Privates Konto | Gemeinsames Konto |
|---|---|---|
| `einzahlung` | Ausgang; mindert „Noch ohne Aufgabe“ | Eingang mit Person; zählt als Einnahme |
| `ausgleich` | Eingang (Erstattung); ohne Wirkung | Ausgang mit Person; ohne Wirkung |

- Die Richtung ist je Art fest. Die Datenbank prüft sie (Constraint-Trigger), Regeln bekommen sie
  als Merkmal, und eine Regel, deren Ziel nicht zur Richtung passt, greift nicht. So kann eine
  Regel einen Import nie scheitern lassen. Seit FREI-18 gilt das nur noch für die Einzahlung;
  der Ausgleich geht auch in Gegenrichtung (Rückzahlung, siehe „Umgekehrter Ausgleich“).
- Auf gemeinsamen Konten nennt `personId`, von wem bzw. an wen das Geld geht. Auf privaten Konten
  ist es immer die Inhaberin; dort bleibt das Feld leer.
- Eine Einzahlung ist **keine negative Einnahme**. Der Erst-ich-Anteil rechnet mit den vollen
  Einnahmen: erst sich selbst bezahlen, dann andere. „Noch ohne Aufgabe“ = Einnahmen −
  Einzahlungen − Zuweisungen − … (ADR 0003, ergänzt).

### Abgleich eigener Überweisungen

Ist die Gegenpartei-IBAN ein eigenes Konto, schlägt der Server die Art selbst vor (Quelle
`abgleich`, Konfidenz 100):

- gleicher Haushalt → `umbuchung`
- privat → gemeinsam: `einzahlung`; gemeinsam → privat: `ausgleich`
- auf dem gemeinsamen Konto mit der Person, der das private Konto gehört

Reihenfolge: Regeln, dann Abgleich, dann LLM. Überweisungen zwischen eigenen Konten gehen damit nie
an ein Modell. Die Begründung nennt nur den Namen der Person, nie ihr privates Konto. Hat eine
Person ihr Konto nicht in Freiraum, ordnet man die erste Einzahlung von Hand zu; daraus entsteht
wie gewohnt eine Regel (Gegenpartei-IBAN → Einzahlung von dieser Person).

Erkannt wird beim Import. Wer ein Konto samt IBAN erst später anlegt, ordnet ältere offene
Buchungen von Hand zu (oder legt eine Regel an, die sie neu vorschlägt).

### Einzahlungsregeln

- Je Person und gemeinsamem Haushalt, gültig **ab einem Monat**. Es gilt die jüngste Regel bis zum
  Monat; ältere bleiben für die Historie.
- `fest`: Betrag je Monat (0 = Pause). `prozent`: Anteil der Einnahmen der Person im Monat, aus
  ihrem privaten Haushalt (Netto, wie beim Erst-ich-Anteil).
- **Jede Person setzt nur ihre eigene Regel**, beide sehen beide. Eine Standardregel gibt es im
  Code bewusst nicht: Sie ist eine Absprache zwischen den beiden und wird als Daten eingetragen.
- Soll und Ist je Monat: Ist = Einzahlungen der Person aufs gemeinsame Konto im Monat (gezählt wird
  die Seite des gemeinsamen Kontos, damit nichts doppelt zählt).

### Ausgleich

- Ordnet eine Person eine Buchung ihres privaten Kontos einem Topf des gemeinsamen Haushalts zu,
  trägt der gemeinsame Topf die Ausgabe. Das private Budget bleibt unberührt: Das Geld ist eine
  Forderung ans Gemeinsame, keine eigene Ausgabe. Teilweise geht auch (z. B. 40 € gemeinsam, 60 €
  privat).
- Erledigt wird der Ausgleich durch eine Überweisung vom gemeinsamen aufs private Konto (Art
  `ausgleich`, meist per Abgleich erkannt) oder **von Hand** (z. B. bar). Von Hand verbucht nur die
  Person, die das Geld bekommen hat, und höchstens den offenen Rest.
- Wie beim Budget wird alles aus der Historie gerechnet, nichts fortgeschrieben. Erstattungen sind
  keiner einzelnen Ausgabe zugeordnet; sie decken die Ausgaben der Reihe nach, älteste zuerst.
  Ändert sich eine Aufteilung später, stimmt der Stand trotzdem.

### Umgekehrter Ausgleich (FREI-18)

Zahlt jemand mit der Karte des gemeinsamen Kontos etwas Privates, ordnet die Person die Buchung
ihrem eigenen privaten Topf zu (auch teilweise).

- Der private Topf trägt die Ausgabe. Das gemeinsame Budget bleibt unberührt: Das Geld ist eine
  **Schuld der Person ans Gemeinsame**, keine gemeinsame Ausgabe. Das ist das Spiegelbild der
  Forderung oben.
- Nur die Inhaberin wählt ihren privaten Topf, nie die andere Person (422
  `topf_anderer_haushalt`). Die Datenbank lässt nur private Töpfe von Mitgliedern zu.
- **Keine Regel.** Eine Regel im gemeinsamen Haushalt träfe auch die Käufe der anderen Person
  bei derselben Gegenpartei. Korrekturen lernen deshalb nichts, und eine Regel mit privatem Topf
  im Gemeinsamen wird abgelehnt (422 `regel_privater_topf`).
- Zurückgezahlt wird per Überweisung vom privaten aufs gemeinsame Konto mit der Art
  `ausgleich`. **Der Ausgleich hat deshalb keine feste Richtung mehr**: Ausgang vom gemeinsamen
  Konto = Erstattung an die Person, Eingang = Rückzahlung der Person. Auf beiden Seiten ohne
  Wirkung aufs Budget. Die Einzahlung behält ihre feste Richtung.
- Der Abgleich schlägt für Überweisungen aufs gemeinsame Konto weiter `einzahlung` vor; eine
  Rückzahlung korrigiert man von Hand. Diese Korrektur lernt keine Regel, sonst würden künftige
  Einzahlungen zu Rückzahlungen. Regeln für den Ausgleich ohne eigene Richtung bekommen die
  übliche (Erstattung ans Private).
- Im Ausgleich steht je Person ein **Saldo**: Forderung − Erstattungen − (Schuld −
  Rückzahlungen). Positiv schuldet das Gemeinsame der Person etwas, negativ die Person dem
  Gemeinsamen. Forderung und Schuld verrechnen sich gegenseitig, jeweils älteste Buchung zuerst.
  Offene Schulden stehen getrennt von den offenen Forderungen (`openDebts`).
- Von Hand verbuchen lässt sich weiterhin nur eine eigene Forderung, höchstens der Saldo.
- Privatsphäre: Die Buchung gehört zum gemeinsamen Konto, beide sehen sie ohnehin. Vom privaten
  Topf ist dort nur die ID zu sehen. Budget und Töpfe des privaten Haushalts bleiben ohne
  Freigabe `budget` „nicht gefunden“. Der Ausgleich nennt den Topf gar nicht.

### Verrechnen mit der Einzahlung (FREI-28)

Statt 50 € zurückzuüberweisen und 500 € einzuzahlen, zahlt man 450 € ein und verrechnet 50 €.
Entschieden am 17.11.2026: Freiraum bietet das an, Überweisungen in beide Richtungen bleiben
daneben möglich.

- Eine Verrechnung ist ein **von Hand verbuchter Ausgleich der Art `verrechnung`**
  (`settlements.kind`, Migration 0009). Der bisherige Ausgleich von Hand (z. B. bar erhalten) hat
  die Art `zahlung` und wirkt weiterhin nicht aufs Budget.
- Der verrechnete Betrag **zählt wie eine Einzahlung**, und zwar im Monat von `settledOn`:
  im Gemeinsamen als Eingang, im privaten Haushalt der Person als Minderung von „Noch ohne
  Aufgabe“, im Ist der Einzahlungsregel. Zugleich gilt er im Ausgleich als Erstattung. Nur so
  stimmen beide Budgets mit den Kontoständen: Das Gemeinsame hat 450 € auf dem Konto und 50 €
  im Topf ausgegeben, also müssen 500 € hereingekommen sein; privat sind 500 € weg, aber nur
  450 € als Einzahlung gebucht.
- **Beide Richtungen.** Die Richtung ergibt sich aus dem Saldo der Person. Bei einer Forderung
  wird der Betrag positiv gespeichert (Erstattung, zählt als mehr Einzahlung). Bei einer Schuld
  (umgekehrter Ausgleich) wird er negativ gespeichert: Wer 530 € einzahlt und 30 € Schuld
  verrechnet, hat 500 € Ist und keine Schuld mehr; im privaten Budget kommen die 30 € zurück
  nach „Noch ohne Aufgabe“, weil der private Topf die Ausgabe schon trägt.
- Höchstens der offene Saldo, und **nur die Person selbst**: Eine Verrechnung ändert ihr privates
  Budget, also verbucht und nimmt sie nur sie zurück. Die andere Person sieht sie im Ausgleich
  (`manual`), wie jede Buchung dort.
- Nicht in einem **abgeschlossenen Monat** und nicht **vor dem Budgetbeginn** eines der beiden
  Haushalte (409). Sonst änderte sich ein festgehaltener Stand, oder die Verrechnung fiele in
  einem Haushalt aus der Rechnung und die Budgets stimmten nicht mehr. Danach füllt Erst-ich in
  beiden Haushalten neu, wie nach einer Einzahlung.
- Verworfene Alternative: die Überweisung auf beiden Konten aufteilen (450 € = 500 € Einzahlung −
  50 € Ausgleich). Das rechnet seit FREI-18 schon richtig, braucht aber zwei Korrekturen von Hand
  an zwei Buchungen, die der Abgleich jedes Mal wieder als reine Einzahlung vorschlägt. Die
  Verrechnung ist ein Eintrag, unabhängig von Buchung und Import.

### Freigaben

| Freigabe | Was die andere Person sieht |
|---|---|
| `erst_ich` | ob die Erst-ich-Töpfe des Monats ihre Rate haben, als Ja/Nein und Prozent |
| `ruecklagen` | dasselbe für die Rücklagen |
| `einzahlung_soll` | das Soll der eigenen Regel „Prozent vom Netto“ |
| `budget` | Budget und Töpfe des privaten Haushalts lesen |
| `sparquote` | die Sparquote des Monats als ganzer Prozentwert (ADR 0005), null ohne Einkommen |

- Freigaben gibt es nur an die Person, mit der man einen Haushalt teilt. Geprüft wird bei jeder
  Anfrage; Zurücknehmen wirkt sofort.
- **Kennzahlen sind Anteile, keine Beträge.** Aus „Erst ich zu 100 % erledigt“ oder einer
  Sparquote von 30 % lässt sich kein Einkommen zurückrechnen. Die Sparquote kommt deshalb auf ganze
  Prozent abgerundet, nicht in Basispunkten.
- Das Soll einer Regel „Prozent vom Netto“ verrät das Einkommen. Ohne `einzahlung_soll` sieht die
  andere Person nur Regel und Ist. Ein fester Betrag ist ohnehin bekannt und immer sichtbar.
- `budget` öffnet nur das **Lesen** von Budget und Töpfen. Buchungen, Konten, Regeln und jede
  Änderung bleiben „nicht gefunden“ (404).
- Eine private Buchung, die einem gemeinsamen Topf zugeordnet ist, gehört insoweit dem
  Gemeinsamen: Beide sehen im Ausgleich Datum, Gegenpartei und den gemeinsamen Anteil. Konto,
  Verwendungszweck und der private Anteil bleiben privat.

## Folgen

- Budgetbeginn (ADR 0003): Einzahlungen vor dem Startmonat zählen nicht im Budget, und vorher gibt
  es auch keinen Abgleich (wie bei allen Vorschlägen). Soll/Ist der Einzahlungen und der Ausgleich
  sind Forderungen zwischen den Personen und rechnen unabhängig davon.
- Die Sparquote ([ADR 0005](0005-auswertungen.md)) ist seit FREI-19 als Freigabe `sparquote`
  ergänzt (Migration 0007). Einzahlungen ins Gemeinsame mindern die private Sparquote.
- Ausgaben vom gemeinsamen Konto für einen privaten Topf (umgekehrter Ausgleich) sind seit
  FREI-18 umgesetzt (Migration 0008), das Verrechnen mit der Einzahlung seit FREI-28
  (Migration 0009).
- Seit FREI-22 rechnen die Auswertungen Verrechnungen wie Einzahlungen und Ausgaben über
  Haushaltsgrenzen beim Topf, wie das Budget ([ADR 0005](0005-auswertungen.md), „Über
  Haushalte hinweg“). Den Geldfluss über beide Haushalte sieht nur die Person selbst; eine
  Freigabe dafür gibt es nicht.
- Das LLM bekommt weiterhin nur die Töpfe des Haushalts, zu dem das Konto gehört, also keine
  gemeinsamen Töpfe bei privaten Konten. Ob das reicht, zeigt der Alltag.
- Welche Einzahlungsregel gilt, legen die beiden Personen gemeinsam fest und tragen sie als Daten
  ein (Art, Betrag bzw. Anteil, Startmonat). Freiraum gibt dafür nichts vor.

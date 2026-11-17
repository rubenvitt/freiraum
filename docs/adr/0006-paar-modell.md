# ADR 0006: Paar-Modell (E4)

Stand: 17.11.2026 · Status: vorgeschlagen (mit FREI-5)

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
  Regel einen Import nie scheitern lassen.
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
- Ausgaben vom gemeinsamen Konto für einen privaten Topf (umgekehrter Ausgleich) und das Verrechnen
  eines Ausgleichs mit der nächsten Einzahlung sind nicht umgesetzt.
- Das LLM bekommt weiterhin nur die Töpfe des Haushalts, zu dem das Konto gehört, also keine
  gemeinsamen Töpfe bei privaten Konten. Ob das reicht, zeigt der Alltag.
- Welche Einzahlungsregel gilt, legen die beiden Personen gemeinsam fest; die Spec führt das
  weiter unter „Offene Entscheidungen“.

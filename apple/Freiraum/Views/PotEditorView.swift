import FreiraumKit
import SwiftUI

/// Topf anlegen oder bearbeiten: Name, Art, Plan, Gruppe; beim Bearbeiten auch archivieren.
struct PotEditorView: View {
    /// Zu bearbeitender Topf; nil = neuer Topf im Haushalt `householdId`.
    let pot: Pot?
    let householdId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: PotDraft
    @State private var busy = false
    @FocusState private var nameFocused: Bool

    init(householdId: String) {
        self.pot = nil
        self.householdId = householdId
        _draft = State(initialValue: PotDraft())
    }

    init(pot: Pot) {
        self.pot = pot
        self.householdId = pot.householdId
        _draft = State(initialValue: PotDraft(pot: pot))
    }

    /// Gruppen, die es im Haushalt schon gibt (zum Antippen).
    private var groups: [String] {
        var seen = Set<String>()
        return model.pots(of: householdId).compactMap(\.groupName).filter { seen.insert($0).inserted }
    }

    /// Zielmonate: ab dem laufenden (oder dem bisherigen, falls früher) zehn Jahre.
    private var months: [YearMonth] {
        let today = YearMonth.current()
        let first = min(today, draft.targetMonth)
        return (0...120).map { first.adding(months: $0) }
    }

    private var canSave: Bool {
        guard !busy else { return false }
        if let pot { return draft.changes(from: pot).map { !$0.isEmpty } ?? false }
        return draft.input != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, z. B. Lebensmittel", text: $draft.name)
                        .focused($nameFocused)
                        .submitLabel(.done)
                } header: {
                    Text("Name")
                }

                kindSection
                planSection
                groupSection

                if let problem = draft.problem, !draft.name.isEmpty {
                    Section {
                        Text(problem)
                            .font(.footnote)
                            .foregroundStyle(Theme.warning)
                    }
                }

                if let pot, !pot.archived {
                    Section {
                        Button("Topf archivieren", role: .destructive) { archive(pot) }
                            .disabled(busy)
                    } footer: {
                        Text("Geht nur, wenn der Topf leer ist. Archivierte Töpfe lassen sich unter „Archivierte Töpfe“ wiederherstellen.")
                    }
                }

                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            .navigationTitle(pot == nil ? "Neuer Topf" : "Topf bearbeiten")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pot == nil ? "Anlegen" : "Sichern") { save() }
                        .disabled(!canSave)
                }
            }
            .onAppear {
                model.errorMessage = nil
                if pot == nil { nameFocused = true }
            }
        }
    }

    // MARK: Abschnitte

    @ViewBuilder private var kindSection: some View {
        Section {
            if pot == nil {
                Picker("Art", selection: $draft.kind) {
                    ForEach(PotKind.allCases, id: \.self) { kind in
                        Text(kind.title).tag(kind)
                    }
                }
            } else {
                LabeledContent("Art", value: draft.kind.title)
            }
        } footer: {
            Text(pot == nil ? draft.kind.explanation : "\(draft.kind.explanation) Die Art lässt sich nicht mehr ändern.")
        }
    }

    @ViewBuilder private var planSection: some View {
        Section {
            if draft.kind == .erstIch {
                Picker("Füllen mit", selection: $draft.erstIchMode) {
                    ForEach(PotDraft.ErstIchMode.allCases, id: \.self) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
            }
            if draft.showsAmount {
                AmountField(
                    title: draft.amountRequired ? draft.amountLabel : "\(draft.amountLabel) (freiwillig)",
                    text: $draft.amountText, unit: "€"
                )
            }
            if draft.showsPercent {
                AmountField(title: "Anteil der Einnahmen", text: $draft.percentText, unit: "%")
            }
            if draft.showsTargetMonth {
                Toggle("Zielmonat", isOn: $draft.hasTargetMonth)
                if draft.hasTargetMonth {
                    Picker("Erreicht bis", selection: $draft.targetMonth) {
                        ForEach(months, id: \.self) { month in
                            Text(month.title).tag(month)
                        }
                    }
                }
            }
        } header: {
            Text("Plan")
        } footer: {
            Text(planHint)
        }
    }

    private var planHint: String {
        switch draft.kind {
        case .monatlich:
            "Mit Betrag zeigt der Topf jeden Monat, was noch fehlt."
        case .ruecklage:
            if let cents = draft.amountCents {
                "Jeden Monat sind \(Money.format(cents / 12)) geplant."
            } else {
                "Jeden Monat ist ein Zwölftel geplant."
            }
        case .ziel:
            draft.hasTargetMonth
                ? "Die Monatsrate verteilt den Rest bis zum Zielmonat."
                : "Ohne Zielmonat gibt es keine feste Monatsrate."
        case .erstIch:
            "Nach jeder Einnahme füllt Freiraum diesen Topf zuerst, soweit Geld ohne Aufgabe da ist."
        }
    }

    @ViewBuilder private var groupSection: some View {
        Section {
            TextField("Gruppe (freiwillig), z. B. Fixkosten", text: $draft.groupName)
            if !groups.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(groups, id: \.self) { group in
                            Button { draft.groupName = group } label: {
                                Chip(text: group, color: draft.trimmedGroup == group ? Theme.accent : Theme.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Gruppe \(group) wählen")
                        }
                    }
                }
            }
        } header: {
            Text("Gruppe")
        } footer: {
            Text("Töpfe mit gleicher Gruppe stehen in der Liste beisammen.")
        }
    }

    // MARK: Aktionen

    private func save() {
        busy = true
        Task {
            let ok: Bool
            if let pot {
                guard let changes = draft.changes(from: pot) else { busy = false; return }
                ok = await model.updatePot(pot, changes: changes)
            } else {
                guard let input = draft.input else { busy = false; return }
                ok = await model.createPot(input, householdId: householdId)
            }
            busy = false
            if ok { dismiss() }
        }
    }

    private func archive(_ pot: Pot) {
        busy = true
        Task {
            let ok = await model.updatePot(pot, changes: PotChanges(archived: true))
            busy = false
            if ok { dismiss() }
        }
    }
}

/// Zahl mit Einheit in einer Formularzeile.
private struct AmountField: View {
    let title: String
    @Binding var text: String
    let unit: String

    var body: some View {
        HStack {
            TextField(title, text: $text)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
                .monospacedDigit()
            Text(unit).foregroundStyle(Theme.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Reihenfolge aller aktiven Töpfe ändern. Gruppen folgen der Reihenfolge ihrer Töpfe;
/// Erst-ich-Töpfe werden in dieser Reihenfolge gefüllt.
struct PotOrderSheet: View {
    let householdId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var ids: [String] = []
    @State private var busy = false

    private var potsById: [String: Pot] {
        Dictionary(model.pots(of: householdId).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private var original: [String] {
        model.pots(of: householdId).filter { !$0.archived }.map(\.id)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(ids, id: \.self) { id in
                        if let pot = potsById[id] {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(pot.name)
                                Text([pot.kind.title, pot.groupName].compactMap { $0 }.joined(separator: " · "))
                                    .font(.footnote)
                                    .foregroundStyle(Theme.secondary)
                            }
                        }
                    }
                    .onMove { source, destination in
                        ids = PotOrder.move(ids, from: source, to: destination)
                    }
                } footer: {
                    Text("Gruppen erscheinen in der Reihenfolge ihres ersten Topfs. Erst-ich-Töpfe füllen sich von oben nach unten.")
                }
                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            #if os(iOS)
            .environment(\.editMode, .constant(.active))
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .navigationTitle("Reihenfolge")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { save() }
                        .disabled(busy || ids == original)
                }
            }
            .onAppear {
                model.errorMessage = nil
                ids = original
            }
        }
    }

    private func save() {
        busy = true
        Task {
            let ok = await model.reorderPots(householdId: householdId, potIds: ids)
            busy = false
            if ok {
                dismiss()
            } else {
                // Liste vermutlich veraltet (Topf auf anderem Gerät angelegt): neu aufbauen.
                ids = original
            }
        }
    }
}

/// Archivierte Töpfe eines Haushalts mit „Wiederherstellen“.
struct ArchivedPotsView: View {
    let householdId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var pots: [Pot] = []
    @State private var loading = true
    @State private var busy: String?

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    ProgressView()
                } else if pots.isEmpty {
                    Text("Keine archivierten Töpfe.")
                        .foregroundStyle(Theme.secondary)
                }
                ForEach(pots) { pot in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pot.name)
                            Text(pot.kind.title)
                                .font(.footnote)
                                .foregroundStyle(Theme.secondary)
                        }
                        Spacer()
                        Button("Wiederherstellen") { restore(pot) }
                            .disabled(busy != nil)
                    }
                }
                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            .navigationTitle("Archivierte Töpfe")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .task {
                model.errorMessage = nil
                pots = await model.archivedPots(householdId: householdId)
                loading = false
            }
        }
    }

    private func restore(_ pot: Pot) {
        busy = pot.id
        Task {
            if await model.updatePot(pot, changes: PotChanges(archived: false)) {
                pots.removeAll { $0.id == pot.id }
            }
            busy = nil
        }
    }
}

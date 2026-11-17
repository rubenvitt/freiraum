import FreiraumKit
import SwiftUI

/// Alle Töpfe des Haushalts, nach Gruppen. Zuweisen per Tipp auf einen Topf; anlegen, bearbeiten,
/// sortieren und archivieren über das Menü oben und das Kontextmenü eines Topfs.
struct PotsView: View {
    @Environment(AppModel.self) private var model
    @State private var sheet: PotSheet?

    /// Welches Blatt offen ist.
    enum PotSheet: Identifiable {
        case assign(OverviewState.PotRow)
        case create(householdId: String)
        case edit(Pot)
        case order(householdId: String)
        case archived(householdId: String)

        var id: String {
            switch self {
            case let .assign(row): "assign-\(row.id)"
            case let .create(householdId): "create-\(householdId)"
            case let .edit(pot): "edit-\(pot.id)"
            case let .order(householdId): "order-\(householdId)"
            case let .archived(householdId): "archived-\(householdId)"
            }
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                GlowBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        HouseholdPicker()
                        if let household = model.selectedHousehold, let state = model.overview(for: household) {
                            let pots = model.pots(of: household.id)
                            ForEach(groups(state, pots: pots), id: \.name) { group in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(group.name)
                                        .font(.headline)
                                        .foregroundStyle(Theme.text)
                                        .padding(.horizontal, 4)
                                    ForEach(group.rows) { row in
                                        potRow(row, pot: pots.first { $0.id == row.id }, closed: state.closed)
                                    }
                                }
                            }
                            if state.pots.isEmpty {
                                EmptyPots { sheet = .create(householdId: household.id) }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 40)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await model.load() }
            }
            .navigationTitle("Töpfe")
            .toolbar {
                if let household = model.selectedHousehold {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button("Neuer Topf", systemImage: "plus") {
                                sheet = .create(householdId: household.id)
                            }
                            Button("Reihenfolge ändern", systemImage: "arrow.up.arrow.down") {
                                sheet = .order(householdId: household.id)
                            }
                            .disabled(model.pots(of: household.id).count < 2)
                            Button("Archivierte Töpfe", systemImage: "archivebox") {
                                sheet = .archived(householdId: household.id)
                            }
                        } label: {
                            Label("Töpfe verwalten", systemImage: "plus")
                        } primaryAction: {
                            sheet = .create(householdId: household.id)
                        }
                        .accessibilityHint("Tippen legt einen neuen Topf an, gedrückt halten zeigt mehr")
                    }
                }
            }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case let .assign(row):
                AssignmentSheet(potId: row.id, name: row.name) {
                    if let pot = model.pots(of: model.selectedHousehold?.id).first(where: { $0.id == row.id }) {
                        self.sheet = .edit(pot)
                    }
                }
                .presentationDetents([.medium, .large])
            case let .create(householdId):
                PotEditorView(householdId: householdId)
            case let .edit(pot):
                PotEditorView(pot: pot)
            case let .order(householdId):
                PotOrderSheet(householdId: householdId)
            case let .archived(householdId):
                ArchivedPotsView(householdId: householdId)
            }
        }
    }

    /// Ein Topf: Tippen ändert die Zuweisung (im abgeschlossenen Monat: bearbeiten),
    /// das Kontextmenü bietet beides.
    @ViewBuilder
    private func potRow(_ row: OverviewState.PotRow, pot: Pot?, closed: Bool) -> some View {
        Button {
            if !closed {
                sheet = .assign(row)
            } else if let pot {
                sheet = .edit(pot)
            }
        } label: {
            PotRowView(row: row)
        }
        .buttonStyle(.plain)
        .accessibilityHint(closed ? "Topf bearbeiten" : "Zuweisung ändern")
        .contextMenu {
            if !closed {
                Button("Zuweisung ändern", systemImage: "eurosign") { sheet = .assign(row) }
            }
            if let pot {
                Button("Topf bearbeiten", systemImage: "pencil") { sheet = .edit(pot) }
            }
        }
    }

    private struct Group {
        let name: String
        let rows: [OverviewState.PotRow]
    }

    private func groups(_ state: OverviewState, pots: [Pot]) -> [Group] {
        let groupOf = Dictionary(pots.map { ($0.id, $0.groupName ?? "Ohne Gruppe") }, uniquingKeysWith: { a, _ in a })
        var order: [String] = []
        var rows: [String: [OverviewState.PotRow]] = [:]
        for row in state.pots {
            let name = groupOf[row.id] ?? "Ohne Gruppe"
            if rows[name] == nil { order.append(name) }
            rows[name, default: []].append(row)
        }
        return order.map { Group(name: $0, rows: rows[$0] ?? []) }
    }
}

/// Leerer Haushalt: kurz erklären und zum ersten Topf führen.
private struct EmptyPots: View {
    let create: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Noch keine Töpfe")
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                Text("Jeder Euro bekommt eine Aufgabe. Leg zuerst einen Erst-ich-Topf an, etwa 10 % für dich, dann die festen Kosten und den Alltag.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondary)
                Button(action: create) {
                    Label("Ersten Topf anlegen", systemImage: "plus")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
            }
        }
    }
}

/// Zuweisung eines Topfs im angezeigten Monat setzen.
struct AssignmentSheet: View {
    let potId: String
    let name: String
    /// Wechselt zum Bearbeiten des Topfs.
    var edit: (() -> Void)?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var busy = false

    private var budgetPot: BudgetPot? {
        guard let id = model.selectedHousehold?.id else { return nil }
        return model.budgets[id]?.pots.first { $0.potId == potId }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let pot = budgetPot {
                    Section {
                        LabeledContent("Zugewiesen", value: Money.format(pot.assignedCents))
                        LabeledContent("Plan", value: Money.format(pot.planCents))
                        LabeledContent("Verfügbar", value: Money.format(pot.availableCents))
                    }
                    Section {
                        TextField("Betrag", text: $text)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                            .font(.title2.weight(.semibold))
                        if pot.neededCents > 0 {
                            Button("Plan übernehmen (\(Money.format(pot.assignedCents + pot.neededCents)))") {
                                text = Money.number(pot.assignedCents + pot.neededCents, style: .exact)
                            }
                        }
                    } header: {
                        Text("Neue Zuweisung für \(model.month.name)")
                    } footer: {
                        Text("Erhöhen geht, solange „Noch ohne Aufgabe“ reicht. Senken geht immer.")
                    }
                }
                if let edit {
                    Section {
                        Button("Topf bearbeiten", systemImage: "pencil", action: edit)
                    } footer: {
                        Text("Name, Plan und Gruppe ändern oder den Topf archivieren.")
                    }
                }
                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            .navigationTitle(name)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { save() }
                        .disabled(busy || Money.parse(text) == nil)
                }
            }
            .onAppear {
                if let pot = budgetPot { text = Money.number(pot.assignedCents, style: .exact) }
                model.errorMessage = nil
            }
        }
    }

    private func save() {
        guard let cents = Money.parse(text), let household = model.selectedHousehold else { return }
        busy = true
        Task {
            let ok = await model.setAssignment(potId: potId, householdId: household.id, cents: cents)
            busy = false
            if ok { dismiss() }
        }
    }
}

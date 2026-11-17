import FreiraumKit
import SwiftUI

/// Alle Töpfe des Haushalts, nach Gruppen. Zuweisen per Tipp auf einen Topf.
struct PotsView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: OverviewState.PotRow?

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
                                        Button { editing = row } label: { PotRowView(row: row) }
                                            .buttonStyle(.plain)
                                            .disabled(state.closed)
                                            .accessibilityHint("Zuweisung ändern")
                                    }
                                }
                            }
                            if state.pots.isEmpty {
                                Text("Noch keine Töpfe. Töpfe legst du vorerst über die API oder später am Mac an.")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.secondary)
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
        }
        .sheet(item: $editing) { row in
            AssignmentSheet(potId: row.id, name: row.name)
                .presentationDetents([.medium])
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

/// Zuweisung eines Topfs im angezeigten Monat setzen.
struct AssignmentSheet: View {
    let potId: String
    let name: String

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

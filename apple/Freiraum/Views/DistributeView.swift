import FreiraumKit
import SwiftUI

/// „Verteilen“: Töpfe, denen laut Plan noch Geld fehlt, mit einem Tipp füllen.
struct DistributeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    private var budget: BudgetMonth? {
        model.selectedHousehold.flatMap { model.budgets[$0.id] }
    }

    private var needy: [BudgetPot] {
        (budget?.pots ?? []).filter { $0.neededCents > 0 && !$0.archived }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Noch ohne Aufgabe") {
                        Text(Money.format(budget?.readyToAssignCents ?? 0))
                            .monospacedDigit()
                            .fontWeight(.semibold)
                            .foregroundStyle((budget?.readyToAssignCents ?? 0) < 0 ? Theme.warning : Theme.text)
                    }
                    if !needy.isEmpty {
                        Button("Alle nach Plan füllen") { Task { await fillAll() } }
                            .disabled(busy || (budget?.readyToAssignCents ?? 0) <= 0)
                    }
                } footer: {
                    Text("Gefüllt wird der Reihe nach, solange „Noch ohne Aufgabe“ reicht. Einzelne Beträge änderst du unter „Töpfe“.")
                }

                if needy.isEmpty {
                    Section {
                        Text("Alle Töpfe haben, was der Plan vorsieht.").foregroundStyle(Theme.secondary)
                    }
                } else {
                    Section("Laut Plan fehlt") {
                        ForEach(needy) { pot in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(pot.name).foregroundStyle(Theme.text)
                                    Text("zugewiesen \(Money.format(pot.assignedCents)) von \(Money.format(pot.planCents))")
                                        .font(.footnote)
                                        .foregroundStyle(Theme.secondary)
                                }
                                Spacer()
                                Button("+\(Money.format(pot.neededCents))") {
                                    Task { await fill(pot) }
                                }
                                .buttonStyle(.glass)
                                .monospacedDigit()
                                .disabled(busy)
                            }
                        }
                    }
                }

                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            .navigationTitle("Verteilen · \(model.month.name)")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .onAppear { model.errorMessage = nil }
        }
    }

    private func fill(_ pot: BudgetPot) async {
        guard let household = model.selectedHousehold else { return }
        busy = true
        _ = await model.setAssignment(potId: pot.potId, householdId: household.id, cents: pot.assignedCents + pot.neededCents)
        busy = false
    }

    /// Der Reihe nach füllen; ein Topf, der nicht mehr ganz passt, bekommt den Rest.
    private func fillAll() async {
        guard let household = model.selectedHousehold else { return }
        busy = true
        defer { busy = false }
        for pot in needy {
            let ready = model.budgets[household.id]?.readyToAssignCents ?? 0
            guard ready > 0 else { break }
            let amount = min(pot.neededCents, ready)
            let ok = await model.setAssignment(potId: pot.potId, householdId: household.id, cents: pot.assignedCents + amount)
            if !ok { break }
        }
    }
}

import FreiraumKit
import SwiftUI

/// Barausgabe erfassen: Betrag, wofür, Topf. Gebucht wird im Bargeldkonto des Haushalts.
struct CashExpenseView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft = CashExpenseDraft()
    @State private var householdId: String?
    @State private var date = Date()
    @State private var busy = false
    @FocusState private var amountFocused: Bool

    private var household: Household? {
        model.households.first { $0.id == householdId } ?? model.selectedHousehold
    }

    private var pots: [Pot] {
        model.pots(of: household?.id)
            .filter { !$0.archived && $0.kind != .erstIch }
            .sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) }
    }

    private var needsCashAccount: Bool {
        guard let household else { return false }
        return !model.accounts.contains { $0.householdId == household.id && $0.source == .bar }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(alignment: .firstTextBaseline) {
                        TextField("0,00", text: $draft.amountText)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                            .font(.system(size: 44, weight: .semibold))
                            .monospacedDigit()
                            .focused($amountFocused)
                            .accessibilityLabel("Betrag in Euro")
                        Text("€").font(.title).foregroundStyle(Theme.secondary)
                    }
                    TextField("Wofür? (z. B. Bäcker)", text: $draft.description)
                }

                if model.households.count > 1 {
                    Section("Haushalt") {
                        Picker("Haushalt", selection: $householdId) {
                            ForEach(model.households) { h in
                                Text(h.shortLabel).tag(Optional(h.id))
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                    }
                }

                Section("Topf") {
                    if pots.isEmpty {
                        Text("Dieser Haushalt hat noch keine Töpfe.").foregroundStyle(Theme.secondary)
                    }
                    ForEach(pots) { pot in
                        Button {
                            draft.potId = pot.id
                        } label: {
                            HStack {
                                Text(pot.name).foregroundStyle(Theme.text)
                                Spacer()
                                if let available = available(pot.id) {
                                    Text(Money.format(available)).monospacedDigit().foregroundStyle(Theme.secondary)
                                }
                                if draft.potId == pot.id {
                                    Image(systemName: "checkmark").foregroundStyle(Theme.accent)
                                        .accessibilityLabel("ausgewählt")
                                }
                            }
                        }
                    }
                }

                Section {
                    DatePicker("Tag", selection: $date, in: ...Date(), displayedComponents: .date)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if needsCashAccount {
                            Text("Beim ersten Mal legt Freiraum in diesem Haushalt ein Bargeldkonto an.")
                        }
                        if let message = model.errorMessage {
                            Text(message).foregroundStyle(Theme.warning)
                        }
                    }
                }
            }
            .navigationTitle("Barausgabe")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Erfassen") { save() }
                        .disabled(busy || draft.problem != nil)
                }
            }
            .onAppear {
                householdId = householdId ?? model.selectedHousehold?.id
                amountFocused = true
                model.errorMessage = nil
            }
            .onChange(of: householdId) { _, _ in draft.potId = nil }
        }
    }

    private func available(_ potId: String) -> Int? {
        guard let id = household?.id else { return nil }
        return model.budgets[id]?.pots.first { $0.potId == potId }?.availableCents
    }

    private func save() {
        draft.bookingDate = GermanDates.isoDate(date)
        guard let expense = draft.expense, let household else { return }
        busy = true
        Task {
            let ok = await model.recordCash(expense, householdId: household.id)
            busy = false
            if ok { dismiss() }
        }
    }
}

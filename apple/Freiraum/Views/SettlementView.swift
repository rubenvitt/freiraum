import FreiraumKit
import SwiftUI

/// Kurzfassung des Ausgleichs in der Übersicht des gemeinsamen Haushalts.
struct SettlementCard: View {
    let state: SettlementState

    var body: some View {
        GlassCard {
            HStack(spacing: 14) {
                Image(systemName: state.allSettled ? "checkmark.circle" : "arrow.left.arrow.right")
                    .font(.title3)
                    .foregroundStyle(state.allSettled ? Theme.accent : Theme.shared)
                    .frame(width: 44, height: 44)
                    .background((state.allSettled ? Theme.accent : Theme.shared).opacity(0.14), in: .rect(cornerRadius: 14))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ausgleich").font(.headline).foregroundStyle(Theme.text)
                    Text(state.summary).font(.footnote).foregroundStyle(Theme.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundStyle(Theme.secondary)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// Ausgleich im gemeinsamen Haushalt: wer wem wie viel schuldet, offene Forderungen und Schulden.
/// Eigener Saldo lässt sich von Hand verbuchen (bar erhalten, mit der Einzahlung verrechnen),
/// eigene von Hand verbuchte Einträge lassen sich zurücknehmen.
struct SettlementView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recording: SettlementDraft?
    @State private var undoing: SettlementState.ManualRow?
    @State private var busy = false

    private var household: Household? {
        model.households.first { $0.kind == .gemeinsam }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let household, let state = model.settlementState(for: household) {
                    list(state, household: household)
                } else {
                    ContentUnavailableView("Kein Ausgleich", systemImage: "arrow.left.arrow.right",
                                           description: Text("Es gibt noch keinen gemeinsamen Haushalt."))
                }
            }
            .navigationTitle("Ausgleich")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen", systemImage: "xmark") { dismiss() }
                }
            }
            .refreshable { await model.load() }
            .onAppear { model.errorMessage = nil }
            .sheet(item: $recording) { draft in
                if let household {
                    SettlementEditor(household: household, draft: draft)
                }
            }
            .confirmationDialog(
                undoing.map { "„\($0.title)“ zurücknehmen?" } ?? "",
                isPresented: Binding(get: { undoing != nil }, set: { if !$0 { undoing = nil } }),
                titleVisibility: .visible,
                presenting: undoing
            ) { row in
                Button("Zurücknehmen", role: .destructive) { undo(row) }
            } message: { row in
                Text(row.isOffset
                    ? "Der Betrag ist danach wieder offen. Einzahlung (Ist) und dein privates Budget rechnen ohne die Verrechnung."
                    : "Der Betrag ist danach wieder offen.")
            }
        }
    }

    private func list(_ state: SettlementState, household: Household) -> some View {
        List {
            Section {
                ForEach(state.balances) { row in
                    BalanceRowView(row: row)
                }
            } footer: {
                Text("Forderungen und Schulden verrechnen sich. Erstattungen und Rückzahlungen decken die ältesten Buchungen zuerst.")
            }

            if let settlements = model.settlements[household.id],
               let draft = SettlementDraft(settlements, me: model.person) {
                Section {
                    Button(draft.title, systemImage: draft.isClaim ? "banknote" : "arrow.uturn.left") {
                        model.errorMessage = nil
                        recording = draft
                    }
                    .disabled(busy)
                } footer: {
                    Text(draft.isClaim
                        ? "Bar bekommen oder mit deiner Einzahlung verrechnet? Hier eintragen, dann stimmt der Saldo."
                        : "Statt extra zu überweisen: mit deiner Einzahlung ins Gemeinsame verrechnen.")
                }
            }

            if let message = model.errorMessage {
                Section { ErrorBanner(message: message) }
            }

            if !state.debts.isEmpty {
                Section {
                    ForEach(state.debts) { ItemRowView(row: $0) }
                } header: {
                    Text("Offene Schulden")
                } footer: {
                    Text("Private Ausgaben vom gemeinsamen Konto, noch nicht zurückgezahlt.")
                }
            }

            if !state.claims.isEmpty {
                Section {
                    ForEach(state.claims) { ItemRowView(row: $0) }
                } header: {
                    Text("Offene Forderungen")
                } footer: {
                    Text("Gemeinsame Ausgaben, privat bezahlt und noch nicht erstattet.")
                }
            }

            if !state.manual.isEmpty {
                Section {
                    ForEach(state.manual) { row in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title).foregroundStyle(Theme.text)
                                Text(row.subtitle).font(.footnote).foregroundStyle(Theme.secondary)
                            }
                            Spacer()
                            Text(row.amount).monospacedDigit().foregroundStyle(Theme.text)
                        }
                        .accessibilityElement(children: .combine)
                        .swipeActions {
                            if row.deletable {
                                Button("Zurücknehmen", systemImage: "arrow.uturn.backward", role: .destructive) {
                                    undoing = row
                                }
                            }
                        }
                        .contextMenu {
                            if row.deletable {
                                Button("Zurücknehmen", systemImage: "arrow.uturn.backward", role: .destructive) {
                                    undoing = row
                                }
                            }
                        }
                    }
                } header: {
                    Text("Von Hand verbucht")
                } footer: {
                    if state.manual.contains(where: \.deletable) {
                        Text("Eigene Einträge zum Zurücknehmen nach links wischen.")
                    }
                }
            }
        }
    }

    private func undo(_ row: SettlementState.ManualRow) {
        guard let household else { return }
        busy = true
        Task {
            _ = await model.deleteSettlement(row, householdId: household.id)
            busy = false
        }
    }
}

/// Eigenen Ausgleich von Hand verbuchen: Art (bar erhalten oder mit der Einzahlung verrechnen),
/// Betrag (höchstens der offene Saldo), Tag, Notiz.
struct SettlementEditor: View {
    let household: Household

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: SettlementDraft
    @State private var date = Date()
    @State private var busy = false
    @FocusState private var amountFocused: Bool

    init(household: Household, draft: SettlementDraft) {
        self.household = household
        _draft = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if draft.kinds.count > 1 {
                        Picker("Art", selection: $draft.kind) {
                            ForEach(draft.kinds, id: \.self) { kind in
                                Text(SettlementDraft.title(kind)).tag(kind)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                    } else {
                        LabeledContent("Art", value: SettlementDraft.title(draft.kind))
                    }
                } footer: {
                    Text(draft.hint)
                }

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
                    DatePicker("Tag", selection: $date, in: ...Date(), displayedComponents: .date)
                    TextField("Notiz (z. B. bar beim Grillabend)", text: $draft.note)
                } footer: {
                    Text("Offen: \(Money.format(draft.maxCents, style: .exact)). Mehr lässt sich nicht verbuchen.")
                }

                if let problem = draft.problem, !draft.amountText.isEmpty {
                    Section {
                        Text(problem).font(.footnote).foregroundStyle(Theme.warning)
                    }
                }

                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            .navigationTitle(draft.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Verbuchen") { save() }
                        .disabled(busy || draft.input == nil)
                }
            }
            .onAppear {
                model.errorMessage = nil
                amountFocused = true
            }
        }
    }

    private func save() {
        draft.settledOn = GermanDates.isoDate(date)
        guard let input = draft.input else { return }
        busy = true
        Task {
            let ok = await model.recordSettlement(householdId: household.id, input: input)
            busy = false
            if ok { dismiss() }
        }
    }
}

private struct BalanceRowView: View {
    let row: SettlementState.BalanceRow

    private var color: Color {
        switch row.direction {
        case .owedToPerson: Theme.accent
        case .personOwes: Theme.warning
        case .settled: Theme.secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.name).font(.body.weight(.semibold)).foregroundStyle(Theme.text)
                Spacer()
                if !row.amount.isEmpty {
                    Text(row.amount).font(.body.weight(.semibold)).monospacedDigit().foregroundStyle(color)
                }
            }
            Text(row.sentence).font(.subheadline).foregroundStyle(Theme.text)
            if let detail = row.detail {
                Text(detail).font(.footnote).foregroundStyle(Theme.secondary)
            }
            if let hint = row.hint {
                Text(hint).font(.footnote).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct ItemRowView: View {
    let row: SettlementState.ItemRow

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).foregroundStyle(Theme.text).lineLimit(1)
                Text(row.subtitle).font(.footnote).foregroundStyle(Theme.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(row.open).monospacedDigit().fontWeight(.semibold).foregroundStyle(Theme.text)
                if let total = row.ofTotal {
                    Text(total).font(.footnote).monospacedDigit().foregroundStyle(Theme.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

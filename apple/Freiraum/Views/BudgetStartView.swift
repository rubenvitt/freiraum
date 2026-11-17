import FreiraumKit
import SwiftUI

/// Budgetbeginn und Anfangsbestand eines Haushalts: Startmonat wählen, Kontostände erfassen,
/// Konten anlegen. Erreichbar über die Einstellungen.
struct BudgetStartView: View {
    let household: Household

    @Environment(AppModel.self) private var model
    @State private var start: BudgetStart?
    @State private var loading = false
    @State private var saving = false
    @State private var editing: BudgetStart.AccountOpening?
    @State private var addingAccount = false

    var body: some View {
        Form {
            if let start {
                Section {
                    Picker("Startmonat", selection: monthSelection) {
                        ForEach(BudgetStartChoices.months(current: .current(), selected: start.month), id: \.self) { month in
                            Text(month.title).tag(month)
                        }
                    }
                    .disabled(saving)
                } header: {
                    Text("Budgetbeginn")
                } footer: {
                    Text("Buchungen vor dem Startmonat zählen nicht im Budget. Verschieben geht, solange kein Monat abgeschlossen ist und davor keine Töpfe gefüllt sind.")
                }

                Section {
                    ForEach(start.accounts) { account in
                        Button { editing = account } label: { AccountOpeningRow(account: account) }
                            .accessibilityHint("Kontostand erfassen")
                    }
                    Button("Konto hinzufügen", systemImage: "plus") { addingAccount = true }
                } header: {
                    Text("Kontostände")
                } footer: {
                    Text("Trag für jedes Konto den Stand eines Tages ein, etwa aus der Banking-App. Freiraum rechnet daraus den Stand zu Beginn des Startmonats zurück.")
                }

                Section {
                    LabeledContent("Anfangsbestand") {
                        Text(Money.format(start.openingBalanceCents, style: .exact))
                            .monospacedDigit()
                            .foregroundStyle(start.openingBalanceCents < 0 ? Theme.warning : Theme.text)
                    }
                } footer: {
                    Text(start.summary)
                }
            } else if loading {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }

            if let message = model.errorMessage {
                Section {
                    ErrorBanner(message: message, retry: retry)
                }
            }
        }
        .navigationTitle(household.kind == .privat ? "Mein Budget" : household.name)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { account in
            BalanceSheet(account: account, householdId: household.id) { start = $0 }
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $addingAccount) {
            NewAccountSheet(householdId: household.id) { start = $0 }
                .presentationDetents([.medium])
        }
    }

    /// Erneut laden, solange noch nichts geladen ist.
    private var retry: (() -> Void)? {
        guard start == nil else { return nil }
        return { Task { await load() } }
    }

    /// Der Server bleibt führend: Lehnt er ab, zeigt die Auswahl weiter den alten Monat.
    private var monthSelection: Binding<YearMonth> {
        Binding(
            get: { start?.month ?? .current() },
            set: { month in
                guard month != start?.month else { return }
                saving = true
                Task {
                    if let changed = await model.setBudgetStart(month, householdId: household.id) {
                        start = changed
                    }
                    saving = false
                }
            }
        )
    }

    private func load() async {
        loading = true
        model.errorMessage = nil
        if let loaded = await model.budgetStart(householdId: household.id) {
            start = loaded
        }
        loading = false
    }
}

/// Ein Konto mit Kontostand (oder Hinweis, dass er fehlt) und Anfangsbestand.
private struct AccountOpeningRow: View {
    let account: BudgetStart.AccountOpening

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name).foregroundStyle(Theme.text)
                if let balance = account.balance {
                    Text("Stand \(GermanDates.dayAndMonth(balance.date)): \(Money.format(balance.cents, style: .exact))")
                        .font(.footnote)
                        .monospacedDigit()
                        .foregroundStyle(Theme.secondary)
                } else {
                    Text("Noch kein Kontostand")
                        .font(.footnote)
                        .foregroundStyle(Theme.warning)
                }
            }
            Spacer()
            if let opening = account.openingBalanceCents {
                Text(Money.format(opening, style: .exact))
                    .monospacedDigit()
                    .foregroundStyle(opening < 0 ? Theme.warning : Theme.text)
                    .accessibilityLabel("Anfangsbestand \(Money.format(opening, style: .exact))")
            }
        }
        .contentShape(.rect)
    }
}

/// Kontostand eines Kontos erfassen: Betrag, Minus, Stichtag.
private struct BalanceSheet: View {
    let account: BudgetStart.AccountOpening
    let householdId: String
    let saved: (BudgetStart) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: BalanceDraft
    @State private var date: Date
    @State private var busy = false
    @FocusState private var amountFocused: Bool

    init(account: BudgetStart.AccountOpening, householdId: String, saved: @escaping (BudgetStart) -> Void) {
        self.account = account
        self.householdId = householdId
        self.saved = saved
        let draft = BalanceDraft(balance: account.balance)
        _draft = State(initialValue: draft)
        // Mittag UTC, damit der Tag in jeder Zeitzone Europas derselbe bleibt.
        _date = State(initialValue: GermanDates.parseISODate(draft.date).map { $0.addingTimeInterval(12 * 3600) } ?? Date())
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(alignment: .firstTextBaseline) {
                        if draft.negative {
                            Text(Money.minus).font(.system(size: 44, weight: .semibold)).foregroundStyle(Theme.warning)
                        }
                        TextField("0,00", text: $draft.amountText)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                            .font(.system(size: 44, weight: .semibold))
                            .monospacedDigit()
                            .focused($amountFocused)
                            .accessibilityLabel("Kontostand in Euro")
                        Text("€").font(.title).foregroundStyle(Theme.secondary)
                    }
                    Toggle("Konto im Minus", isOn: $draft.negative)
                    DatePicker("Stichtag", selection: $date, in: ...Date(), displayedComponents: .date)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Stand am Ende des Stichtags, mit allen Buchungen bis dahin. Ein neuer Stand ersetzt den alten.")
                        if !draft.amountText.isEmpty, let problem = draft.problem {
                            Text(problem).foregroundStyle(Theme.warning)
                        }
                        if let message = model.errorMessage {
                            Text(message).foregroundStyle(Theme.warning)
                        }
                    }
                }
            }
            .navigationTitle(account.name)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { save() }
                        .disabled(busy || draft.problem != nil)
                }
            }
            .onAppear {
                amountFocused = account.balance == nil
                model.errorMessage = nil
            }
            .onChange(of: date) { _, new in draft.date = GermanDates.isoDate(new) }
        }
    }

    private func save() {
        guard draft.problem == nil, let cents = draft.cents else { return }
        busy = true
        Task {
            let result = await model.setBalance(accountId: account.accountId, cents: cents, date: draft.date, householdId: householdId)
            busy = false
            if let result {
                saved(result)
                dismiss()
            }
        }
    }
}

/// Konto anlegen, etwa das Girokonto, bevor der Kontoimport läuft.
private struct NewAccountSheet: View {
    let householdId: String
    let saved: (BudgetStart) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var source: Account.Source = .bank
    @State private var busy = false
    @FocusState private var nameFocused: Bool

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name (z. B. Girokonto)", text: $name)
                        .focused($nameFocused)
                    Picker("Art", selection: $source) {
                        Text("Bankkonto").tag(Account.Source.bank)
                        Text("Bargeld").tag(Account.Source.bar)
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Danach trägst du den Kontostand ein. Bargeld erfasst du wie gewohnt über „Barausgabe“.")
                        if let message = model.errorMessage {
                            Text(message).foregroundStyle(Theme.warning)
                        }
                    }
                }
            }
            .navigationTitle("Neues Konto")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Anlegen") { save() }
                        .disabled(busy || trimmedName.isEmpty || trimmedName.count > 100)
                }
            }
            .onAppear {
                nameFocused = true
                model.errorMessage = nil
            }
        }
    }

    private func save() {
        busy = true
        Task {
            let result = await model.addAccount(name: trimmedName, source: source, householdId: householdId)
            busy = false
            if let result {
                saved(result)
                dismiss()
            }
        }
    }
}

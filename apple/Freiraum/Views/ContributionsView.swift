import FreiraumKit
import SwiftUI

/// Karte in der Übersicht des gemeinsamen Haushalts: Soll und Ist beider Personen im Monat.
struct ContributionsCard: View {
    let state: ContributionsState
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            GlassCard {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Einzahlungen").font(.headline).foregroundStyle(Theme.text)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(Theme.secondary)
                            .accessibilityHidden(true)
                    }
                    ForEach(state.rows) { row in
                        ContributionRowView(row: row)
                    }
                    if state.missingOwnRule {
                        Label("Lege fest, wie viel du einzahlst.", systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(Theme.warning)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("Öffnet Regel, Freigabe und Verlauf der Einzahlungen")
    }
}

/// Eine Person: Regel, Soll, Ist, offen.
struct ContributionRowView: View {
    let row: ContributionsState.Row

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name).font(.body.weight(.semibold)).foregroundStyle(Theme.text)
                    Text(row.rule).font(.footnote).foregroundStyle(Theme.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(row.paid)
                        .font(.body.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.text)
                    if let target = row.target {
                        Text(target).font(.footnote).monospacedDigit().foregroundStyle(Theme.secondary)
                    }
                }
            }
            if let progress = row.progress {
                ProgressBar(progress: progress, color: row.done ? Theme.accent : Theme.shared)
            }
            if let status = row.status {
                Label(status, systemImage: row.done ? "checkmark.circle" : "circle.dashed")
                    .font(.footnote)
                    .foregroundStyle(row.done ? Theme.accent : Theme.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Einzahlungen ins Gemeinsame: Soll und Ist im Monat, eigene Regel, Freigabe des Solls, Verlauf.
struct ContributionsView: View {
    let household: Household

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var deleting: ContributionHistory.Entry?
    @State private var busy = false

    private var me: String? { model.person?.id }
    private var partner: Person? { model.partner(in: household) }
    private var rules: [ContributionRule] { model.contributionRules[household.id] ?? [] }
    private var ownRule: ContributionRule? {
        me.flatMap { ContributionRule.active(in: rules, personId: $0, month: model.month) }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let state = model.contributionsState(for: household) {
                    Section(model.month.title) {
                        ForEach(state.rows) { row in
                            ContributionRowView(row: row)
                        }
                    }
                }

                ownRuleSection
                shareSection
                historySections

                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            .navigationTitle("Einzahlungen")
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
                await model.loadContributionDetails(householdId: household.id)
            }
            .refreshable { await model.loadContributionDetails(householdId: household.id) }
            .sheet(isPresented: $editing) {
                ContributionRuleEditor(
                    household: household, current: ownRule, month: model.month, partner: partner?.displayName
                )
            }
            .confirmationDialog(
                deleting.map { "Regel \($0.since) löschen?" } ?? "",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible,
                presenting: deleting
            ) { entry in
                Button("Löschen", role: .destructive) { delete(entry) }
            } message: { _ in
                Text("Danach gilt wieder die Regel davor.")
            }
        }
    }

    // MARK: Abschnitte

    @ViewBuilder private var ownRuleSection: some View {
        Section {
            LabeledContent("Gilt im \(model.month.name)", value: ownRule?.text ?? "Keine Regel")
            Button(ownRule == nil ? "Regel festlegen" : "Regel ändern") { editing = true }
                .disabled(busy)
        } header: {
            Text("Deine Regel")
        } footer: {
            Text("Fest: derselbe Betrag jeden Monat, 0 € heißt Pause. Anteil: ein Teil deiner Einnahmen im Monat (Netto). Die Regel gilt ab einem Monat, bis du eine neue festlegst.")
        }
    }

    @ViewBuilder private var shareSection: some View {
        if let partner {
            Section {
                Toggle("Soll für \(partner.displayName) freigeben", isOn: shareBinding(partner))
                    .disabled(busy || model.shares == nil)
            } header: {
                Text("Freigabe")
            } footer: {
                Text(ContributionPrivacy.hint(rule: ownRule, partner: partner.displayName))
            }
        }
    }

    private func shareBinding(_ partner: Person) -> Binding<Bool> {
        Binding(
            get: { model.shares?.hasGranted(.einzahlungSoll, to: partner.id) ?? false },
            set: { granted in
                busy = true
                Task {
                    _ = await model.setShare(.einzahlungSoll, to: partner.id, granted: granted)
                    busy = false
                }
            }
        )
    }

    @ViewBuilder private var historySections: some View {
        let history = ContributionHistory(rules: rules, members: household.members, me: me, month: model.month)
        ForEach(history.people) { person in
            Section {
                if person.entries.isEmpty {
                    Text("Noch keine Regel").foregroundStyle(Theme.secondary)
                }
                ForEach(person.entries) { entry in
                    HistoryRow(entry: entry)
                        .swipeActions {
                            if entry.deletable {
                                Button("Löschen", systemImage: "trash", role: .destructive) { deleting = entry }
                            }
                        }
                        .contextMenu {
                            if entry.deletable {
                                Button("Löschen", systemImage: "trash", role: .destructive) { deleting = entry }
                            }
                        }
                }
            } header: {
                Text(person.isMe ? "Verlauf: deine Regeln" : "Verlauf: \(person.name)")
            } footer: {
                if person.isMe && !person.entries.isEmpty {
                    Text("Zum Löschen nach links wischen. Danach gilt ab diesem Monat wieder die Regel davor.")
                }
            }
        }
    }

    private func delete(_ entry: ContributionHistory.Entry) {
        busy = true
        Task {
            _ = await model.deleteContributionRule(householdId: household.id, from: entry.validFrom)
            busy = false
        }
    }
}

private struct HistoryRow: View {
    let entry: ContributionHistory.Entry

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.text).foregroundStyle(Theme.text)
                Text(entry.since).font(.footnote).foregroundStyle(Theme.secondary)
            }
            Spacer()
            if entry.active {
                Text("gilt").font(.footnote.weight(.semibold)).foregroundStyle(Theme.accent)
            } else if entry.upcoming {
                Text("geplant").font(.footnote.weight(.semibold)).foregroundStyle(Theme.shared)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Eigene Regel festlegen: fest oder Anteil, gültig ab einem Monat.
struct ContributionRuleEditor: View {
    let household: Household
    let current: ContributionRule?
    let partner: String?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ContributionRuleDraft
    @State private var busy = false

    /// - Parameter month: angezeigter Monat; ab ihm gilt die neue Regel, wenn nichts anderes gewählt wird.
    init(household: Household, current: ContributionRule?, month: YearMonth, partner: String?) {
        self.household = household
        self.current = current
        self.partner = partner
        _draft = State(initialValue: ContributionRuleDraft(rule: current, month: month))
    }

    /// Startmonate: ein Jahr vor bis zwei Jahre nach dem laufenden Monat, mindestens samt Vorbelegung.
    private var months: [YearMonth] {
        let today = YearMonth.current()
        let first = min(today.adding(months: -12), draft.validFrom)
        let last = max(today.adding(months: 24), draft.validFrom)
        var result: [YearMonth] = []
        var month = first
        while month <= last {
            result.append(month)
            month = month.next
        }
        return result
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Art", selection: $draft.kind) {
                        ForEach(ContributionRule.Kind.allCases, id: \.self) { kind in
                            Text(kind.title).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    switch draft.kind {
                    case .fest:
                        AmountField(title: "Betrag je Monat", text: $draft.amountText, unit: "€")
                    case .prozent:
                        AmountField(title: "Anteil deiner Einnahmen", text: $draft.percentText, unit: "%")
                    }
                } header: {
                    Text("Wie viel du einzahlst")
                } footer: {
                    Text(kindHint)
                }

                Section {
                    Picker("Gilt ab", selection: $draft.validFrom) {
                        ForEach(months, id: \.self) { month in
                            Text(month.title).tag(month)
                        }
                    }
                } footer: {
                    Text("Gibt es für diesen Monat schon eine Regel von dir, wird sie ersetzt. Frühere Regeln bleiben im Verlauf.")
                }

                if let problem = draft.problem, !(draft.kind == .fest ? draft.amountText : draft.percentText).isEmpty {
                    Section {
                        Text(problem).font(.footnote).foregroundStyle(Theme.warning)
                    }
                }

                if let message = model.errorMessage {
                    Section { ErrorBanner(message: message) }
                }
            }
            .navigationTitle(current == nil ? "Regel festlegen" : "Regel ändern")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { save() }
                        .disabled(busy || draft.input == nil)
                }
            }
            .onAppear { model.errorMessage = nil }
        }
    }

    private var kindHint: String {
        let other = partner ?? "Die andere Person"
        switch draft.kind {
        case .fest:
            return "Derselbe Betrag jeden Monat. \(other) sieht ihn."
        case .prozent:
            return "Soll = Anteil deiner Einnahmen im Monat aus deinem privaten Haushalt. \(other) sieht den Anteil, das Soll nur mit deiner Freigabe."
        }
    }

    private func save() {
        guard let input = draft.input else { return }
        busy = true
        Task {
            let ok = await model.setContributionRule(householdId: household.id, from: draft.validFrom, rule: input)
            busy = false
            if ok { dismiss() }
        }
    }
}

import FreiraumKit
import SwiftUI

/// „Buchungen bestätigen“: eine Karte nach der anderen, „Passt“ mit einem Tipp.
struct ConfirmView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var initialCount = 0
    @State private var skipped: Set<String> = []
    @State private var busy = false
    @State private var changing: Transaction?
    @State private var splitting: Transaction?

    private var queue: [Transaction] {
        model.pending.filter { !skipped.contains($0.id) }
    }

    private var today: String { GermanDates.isoDate(Date()) }

    var body: some View {
        NavigationStack {
            ZStack {
                GlowBackground()
                if let current = queue.first {
                    ScrollView {
                        VStack(spacing: 22) {
                            card(for: current)
                            actions(for: current)
                            upcoming
                        }
                        .padding(.horizontal, 20)
                        .padding(.bottom, 32)
                        .frame(maxWidth: 560)
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    doneView
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 6) {
                        Text("Buchungen bestätigen").font(.subheadline.weight(.semibold))
                        ProgressDots(total: initialCount, done: initialCount - queue.count)
                    }
                }
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .onAppear {
            initialCount = model.pending.count
            model.errorMessage = nil
        }
        .sheet(item: $changing) { transaction in
            TargetPicker(transaction: transaction) { target in
                Task { await apply(transaction, splits: [Split(target: target, amountCents: transaction.amountCents)]) }
            }
        }
        .sheet(item: $splitting) { transaction in
            SplitSheet(transaction: transaction) { splits in
                Task { await apply(transaction, splits: splits) }
            }
        }
    }

    private func card(for t: Transaction) -> some View {
        let household = model.household(of: t)
        let info = ConfirmCard(
            transaction: t, account: model.account(t.accountId), household: household,
            pots: model.pots(of: household?.id), today: today
        )
        return GlassCard(cornerRadius: 32, padding: 22) {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(info.when).font(.footnote).foregroundStyle(Theme.secondary)
                    Text(info.title).font(.title2.weight(.semibold)).foregroundStyle(Theme.text)
                    Text(info.amount)
                        .font(.system(size: 52, weight: .semibold))
                        .monospacedDigit()
                        .kerning(-2)
                        .foregroundStyle(info.isIncome ? Theme.accent : Theme.text)
                        .minimumScaleFactor(0.5)
                        .lineLimit(1)
                        .padding(.top, 6)
                }
                Divider().overlay(.white.opacity(0.1))
                VStack(alignment: .leading, spacing: 12) {
                    Text("VORSCHLAG")
                        .font(.caption.weight(.semibold))
                        .kerning(0.8)
                        .foregroundStyle(Theme.secondary)
                    HStack(spacing: 8) {
                        if let suggestion = info.suggestion {
                            Chip(text: suggestion, color: Theme.accent)
                        }
                        if !info.household.isEmpty {
                            Chip(text: info.household, color: info.isShared ? Theme.shared : Theme.personal)
                        }
                        if let confidence = info.confidence {
                            Text(confidence).font(.caption).foregroundStyle(Theme.secondary)
                        }
                    }
                    if let reason = info.reason {
                        Text(reason).font(.footnote).foregroundStyle(Theme.secondary)
                    }
                }
                if let note = info.note {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "arrow.left.arrow.right")
                            .foregroundStyle(Theme.warning)
                            .accessibilityHidden(true)
                        Text(note).font(.footnote).foregroundStyle(Theme.text)
                    }
                    .padding(12)
                    .background(Theme.warning.opacity(0.1), in: .rect(cornerRadius: 16))
                }
            }
        }
    }

    private func actions(for t: Transaction) -> some View {
        let canConfirm = t.status == .vorgeschlagen && t.suggestion != nil
        return VStack(spacing: 10) {
            if let message = model.errorMessage {
                ErrorBanner(message: message)
            }
            Button {
                Task {
                    busy = true
                    _ = await model.confirm(t)
                    busy = false
                }
            } label: {
                Text("Passt")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.glassProminent)
            .disabled(!canConfirm || busy)

            HStack(spacing: 10) {
                Button { changing = t } label: {
                    Text("Ändern").frame(maxWidth: .infinity, minHeight: 36)
                }
                Button { splitting = t } label: {
                    Text("Aufteilen").frame(maxWidth: .infinity, minHeight: 36)
                }
            }
            .buttonStyle(.glass)
            .disabled(busy)

            Button("Später") { skipped.insert(t.id) }
                .font(.footnote)
                .foregroundStyle(Theme.secondary)
                .padding(.top, 4)
        }
    }

    @ViewBuilder
    private var upcoming: some View {
        let rest = Array(queue.dropFirst().prefix(5))
        if !rest.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("DANACH")
                    .font(.caption.weight(.semibold))
                    .kerning(0.8)
                    .foregroundStyle(Theme.secondary)
                    .padding(.horizontal, 4)
                ForEach(rest) { t in
                    HStack {
                        Text(t.counterpartyName ?? t.purpose ?? "Ohne Angaben")
                            .lineLimit(1)
                        Spacer()
                        Text(Money.format(t.amountCents, style: .exact)).monospacedDigit().fontWeight(.semibold)
                    }
                    .font(.subheadline)
                    .foregroundStyle(Theme.text.opacity(0.8))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.white.opacity(0.04), in: .rect(cornerRadius: 16))
                }
            }
        }
    }

    private var doneView: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark")
                .font(.system(size: 36, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(width: 88, height: 88)
                .background(Theme.accent.opacity(0.14), in: .circle)
                .accessibilityHidden(true)
            Text(verbatim: skipped.isEmpty ? "Alles zugeordnet" : "Für jetzt erledigt")
                .font(.title.weight(.bold))
                .foregroundStyle(Theme.text)
            Text(verbatim: skipped.isEmpty
                ? "Dein Budget ist aktuell. Barausgaben erfasst du mit dem Plus."
                : "\(skipped.count) Buchung\(skipped.count == 1 ? "" : "en") für später aufgehoben.")
                .font(.body)
                .foregroundStyle(Theme.secondary)
                .multilineTextAlignment(.center)
            HStack(spacing: 10) {
                Button("Zur Übersicht") { dismiss() }
                    .buttonStyle(.glassProminent)
                if !skipped.isEmpty {
                    Button("Aufgehobene zeigen") { skipped = [] }
                        .buttonStyle(.glass)
                }
            }
            .padding(.top, 8)
        }
        .padding(32)
    }

    private func apply(_ transaction: Transaction, splits: [Split]) async {
        busy = true
        _ = await model.assign(transaction, splits: splits)
        busy = false
    }
}

/// Fortschritt als Punkte; der aktuelle ist breiter.
struct ProgressDots: View {
    let total: Int
    let done: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<min(total, 12), id: \.self) { i in
                Capsule()
                    .fill(i <= done ? Theme.accent : .white.opacity(0.2))
                    .frame(width: i == done ? 18 : 6, height: 6)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(Text(label))
    }

    private var label: String {
        total == 0 ? "Keine Buchungen" : "\(min(done + 1, total)) von \(total)"
    }
}

/// Ziel für eine Buchung wählen (ganzer Betrag).
struct TargetPicker: View {
    let transaction: Transaction
    let choose: (SplitTarget) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let household = model.household(of: transaction)
        let options = TargetOption.options(pots: model.pots(of: household?.id), forIncome: transaction.amountCents > 0)
        let groups = Dictionary(grouping: options, by: \.group)
        let order = options.reduce(into: [String]()) { if !$0.contains($1.group) { $0.append($1.group) } }
        NavigationStack {
            List {
                Section {
                    Text("Weicht deine Wahl vom Vorschlag ab, merkt sich Freiraum das als Regel für \(transaction.counterpartyName ?? "diese Gegenpartei").")
                        .font(.footnote)
                        .foregroundStyle(Theme.secondary)
                }
                ForEach(order, id: \.self) { group in
                    Section(group) {
                        ForEach(groups[group] ?? []) { option in
                            Button {
                                choose(option.target)
                                dismiss()
                            } label: {
                                HStack {
                                    Text(option.label).foregroundStyle(Theme.text)
                                    Spacer()
                                    if transaction.suggestion?.target == option.target {
                                        Text("Vorschlag").font(.caption).foregroundStyle(Theme.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Zuordnen")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
        }
    }
}

/// Buchung auf mehrere Ziele aufteilen.
struct SplitSheet: View {
    let transaction: Transaction
    let save: ([Split]) -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: SplitDraft

    init(transaction: Transaction, save: @escaping ([Split]) -> Void) {
        self.transaction = transaction
        self.save = save
        _draft = State(initialValue: SplitDraft(transaction: transaction))
    }

    var body: some View {
        let household = model.household(of: transaction)
        let options = TargetOption.options(pots: model.pots(of: household?.id), forIncome: transaction.amountCents > 0)
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Betrag", value: Money.format(transaction.amountCents, style: .exact))
                    LabeledContent("Noch zu verteilen", value: Money.format(draft.remainingCents, style: .exact))
                        .foregroundStyle(draft.remainingCents == 0 ? Theme.accent : Theme.warning)
                }
                ForEach($draft.rows) { $row in
                    Section {
                        Picker("Ziel", selection: $row.target) {
                            Text("Bitte wählen").tag(SplitTarget?.none)
                            ForEach(options) { option in
                                Text(option.label).tag(Optional(option.target))
                            }
                        }
                        TextField("Betrag", text: $row.amountText)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                            .monospacedDigit()
                    }
                }
                Section {
                    Button("Weitere Zeile") { draft.rows.append(SplitDraft.Row()) }
                    if draft.remainingCents > 0 {
                        Button("Rest übernehmen") { draft.fillRemainder() }
                    }
                } footer: {
                    if let problem = draft.problem {
                        Text(problem)
                    } else {
                        Text("Mit mehreren Zielen entsteht keine Regel.")
                    }
                }
            }
            .navigationTitle("Aufteilen")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") {
                        if let splits = draft.splits {
                            save(splits)
                            dismiss()
                        }
                    }
                    .disabled(draft.splits == nil)
                }
            }
        }
    }
}

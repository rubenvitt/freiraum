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
struct SettlementView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let household = model.households.first(where: { $0.kind == .gemeinsam }),
                   let state = model.settlementState(for: household) {
                    list(state)
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
        }
    }

    private func list(_ state: SettlementState) -> some View {
        List {
            Section {
                ForEach(state.balances) { row in
                    BalanceRowView(row: row)
                }
            } footer: {
                Text("Forderungen und Schulden verrechnen sich. Erstattungen und Rückzahlungen decken die ältesten Buchungen zuerst.")
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
                Section("Von Hand verbucht") {
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
                    }
                }
            }
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

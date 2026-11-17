#if os(macOS)
import FreiraumKit
import SwiftUI

/// Planungsansicht: Budget des Monats als Tabelle nach Gruppen, Zuweisungen direkt ändern,
/// Geld umschichten und den Monat abschließen.
struct PlanningView: View {
    @Environment(AppModel.self) private var model
    @State private var move: MoveRequest?
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ZStack {
                GlowBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if let error = model.errorMessage {
                            ErrorBanner(message: error) { Task { await model.load() } }
                        }
                        if let household = model.selectedHousehold, let state = model.planning(for: household) {
                            summary(state, household: household)
                            if let message {
                                ErrorBanner(message: message)
                                    .onTapGesture { self.message = nil }
                            }
                            table(state, household: household)
                        } else if model.isLoading {
                            ProgressView().frame(maxWidth: .infinity, minHeight: 240)
                        } else {
                            ContentUnavailableView(
                                "Kein Budget", systemImage: "square.grid.2x2",
                                description: Text("Für diesen Monat ist noch nichts geladen.")
                            )
                        }
                    }
                    .padding(28)
                    .frame(maxWidth: 1100)
                    .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Planung")
            .navigationSubtitle(model.month.title)
            .toolbar {
                ToolbarItem(placement: .navigation) { MacMonthStepper() }
                ToolbarItem(placement: .principal) { MacHouseholdPicker() }
                ToolbarItem(placement: .primaryAction) {
                    Button("Umschichten", systemImage: "arrow.left.arrow.right") {
                        if let id = model.selectedHousehold?.id { move = MoveRequest(householdId: id) }
                    }
                    .disabled(model.selectedHousehold.flatMap { model.planning(for: $0) }?.closed ?? true)
                    .help("Geld zwischen Töpfen verschieben")
                }
            }
        }
        .sheet(item: $move) { request in
            MoveMoneySheet(request: request)
        }
        .onChange(of: model.selectedHouseholdId) { message = nil }
        .onChange(of: model.month) { message = nil }
    }

    // MARK: Kopf

    private func summary(_ state: PlanningState, household: Household) -> some View {
        HStack(alignment: .top, spacing: 16) {
            MacCard {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Noch ohne Aufgabe")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.secondary)
                    Text(state.readyToAssign)
                        .font(.system(size: 44, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(state.readyToAssignCents < 0 ? Theme.warning : Theme.text)
                    Text(subtitle(state))
                        .font(.callout)
                        .foregroundStyle(Theme.secondary)
                }
            }
            MacCard(title: state.closed ? "Monat abgeschlossen" : "Monatsabschluss") {
                Text(state.closing.note)
                    .font(.callout)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    if state.closing.canReopen {
                        Button("Wieder öffnen") { run { await model.reopenMonth(householdId: household.id) } }
                    } else {
                        Button("\(state.month.name) abschließen") { run { await model.closeMonth(householdId: household.id) } }
                            .buttonStyle(.glassProminent)
                            .disabled(!state.closing.canClose)
                    }
                    if busy { ProgressView().controlSize(.small) }
                }
            }
            .frame(maxWidth: 360)
        }
    }

    private func subtitle(_ state: PlanningState) -> String {
        var parts = ["Einnahmen im Monat \(state.inflows)"]
        if state.neededCents > 0 { parts.append("laut Plan fehlen \(Money.format(state.neededCents))") }
        if state.unconfirmedTransactions > 0 {
            parts.append(PendingText.title(state.unconfirmedTransactions) ?? "")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: Tabelle

    private func table(_ state: PlanningState, household: Household) -> some View {
        MacCard {
            VStack(spacing: 0) {
                PlanningRowLayout(name: Text("Topf"), assigned: Text("Zugewiesen"), activity: Text("Ausgegeben"),
                                  available: Text("Verfügbar"), action: Color.clear)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.secondary)
                    .padding(.bottom, 8)
                ForEach(state.groups) { group in
                    Divider().opacity(0.4)
                    PlanningRowLayout(
                        name: Text(group.title).font(.subheadline.weight(.semibold)),
                        assigned: Text(group.assigned), activity: Text(group.activity), available: Text(group.available),
                        action: Color.clear
                    )
                    .foregroundStyle(Theme.secondary)
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                    ForEach(group.rows) { row in
                        PlanningRow(row: row, closed: state.closed, householdId: household.id) { result in
                            message = result
                        } onMove: { source in
                            move = MoveRequest(householdId: household.id, source: source, target: row.archived ? nil : row.potId)
                        }
                    }
                }
            }
        }
    }

    private func run(_ action: @escaping @MainActor () async -> String?) {
        busy = true
        Task {
            message = await action()
            busy = false
        }
    }
}

/// Spalten der Tabelle, damit Kopf, Gruppen und Zeilen bündig sind.
private struct PlanningRowLayout<Name: View, Assigned: View, Activity: View, Available: View, Action: View>: View {
    let name: Name
    let assigned: Assigned
    let activity: Activity
    let available: Available
    let action: Action

    var body: some View {
        HStack(spacing: 16) {
            name.frame(maxWidth: .infinity, alignment: .leading)
            assigned.frame(width: 130, alignment: .trailing)
            activity.frame(width: 110, alignment: .trailing)
            available.frame(width: 120, alignment: .trailing)
            action.frame(width: 28)
        }
        .monospacedDigit()
    }
}

/// Eine Zeile: Topf, Zuweisung (direkt änderbar), Ausgegeben, Verfügbar, Menü.
private struct PlanningRow: View {
    @Environment(AppModel.self) private var model
    let row: PlanningState.Row
    let closed: Bool
    let householdId: String
    let onResult: (String?) -> Void
    let onMove: (MoveMoney.Source) -> Void

    @State private var text = ""
    @State private var saving = false
    @FocusState private var focused: Bool

    var body: some View {
        PlanningRowLayout(
            name: VStack(alignment: .leading, spacing: 2) {
                Text(row.name).foregroundStyle(row.archived ? Theme.secondary : Theme.text)
                if let note = row.note {
                    Text(note).font(.caption).foregroundStyle(row.neededCents > 0 ? Theme.warning : Theme.secondary)
                }
            },
            assigned: assignedField,
            activity: Text(row.activity).foregroundStyle(Theme.secondary),
            available: Text(row.available)
                .font(.callout.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .foregroundStyle(Theme.color(for: row.tone))
                .background(Theme.color(for: row.tone).opacity(0.14), in: .capsule),
            action: Menu {
                Button("Hierher umschichten…") { onMove(.readyToAssign) }
                    .disabled(closed || row.archived)
                Button("Von hier umschichten…") { onMove(.pot(row.potId)) }
                    .disabled(closed || row.availableCents <= 0)
                if row.neededCents > 0 {
                    Button("Fehlende \(Money.format(row.neededCents)) zuweisen") {
                        save(row.assignedCents + row.neededCents)
                    }
                    .disabled(closed)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .accessibilityLabel("Aktionen für \(row.name)")
        )
        .padding(.vertical, 6)
        .onAppear { text = Money.number(row.assignedCents, style: .exact) }
        .onChange(of: row.assignedCents) { _, new in
            if !focused { text = Money.number(new, style: .exact) }
        }
    }

    @ViewBuilder
    private var assignedField: some View {
        if closed || row.archived {
            Text(row.assigned).foregroundStyle(Theme.secondary)
        } else {
            HStack(spacing: 4) {
                if saving { ProgressView().controlSize(.mini) }
                TextField("Zugewiesen", text: $text)
                    .multilineTextAlignment(.trailing)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .onSubmit { submit() }
                    .accessibilityLabel("Zugewiesen für \(row.name)")
                Text("€").foregroundStyle(Theme.secondary)
            }
        }
    }

    private func submit() {
        guard let cents = Money.parse(text) else {
            onResult("„\(text)“ ist kein gültiger Betrag.")
            text = Money.number(row.assignedCents, style: .exact)
            return
        }
        guard cents != row.assignedCents else { return }
        save(cents)
    }

    private func save(_ cents: Int) {
        saving = true
        Task {
            let result = await model.assign(householdId: householdId, potId: row.potId, cents: cents)
            saving = false
            onResult(result)
            if result != nil { text = Money.number(row.assignedCents, style: .exact) }
        }
    }
}

/// Was im Blatt „Umschichten“ vorbelegt ist.
struct MoveRequest: Identifiable {
    let id = UUID()
    let householdId: String
    var source: MoveMoney.Source = .readyToAssign
    var target: String?
}

/// Blatt „Umschichten“: von „Noch ohne Aufgabe“ oder einem Topf in einen anderen Topf. Reicht
/// das Geld nicht, steht die Meldung des Servers im Blatt.
private struct MoveMoneySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let request: MoveRequest

    @State private var source: MoveMoney.Source = .readyToAssign
    @State private var target: String?
    @State private var amount = ""
    @State private var message: String?
    @State private var busy = false

    private var state: PlanningState? {
        model.households.first { $0.id == request.householdId }.flatMap { model.planning(for: $0) }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let state {
                    Picker("Von", selection: $source) {
                        Text("Noch ohne Aufgabe (\(state.readyToAssign))").tag(MoveMoney.Source.readyToAssign)
                        ForEach(state.movable.filter { $0.availableCents > 0 }) { row in
                            Text("\(row.name) (\(row.available))").tag(MoveMoney.Source.pot(row.potId))
                        }
                    }
                    Picker("Nach", selection: $target) {
                        Text("Topf wählen").tag(String?.none)
                        ForEach(state.movable) { row in
                            Text("\(row.name) (\(row.available))").tag(Optional(row.potId))
                        }
                    }
                    TextField("Betrag in €", text: $amount)
                        .onSubmit { submit() }
                    if let message {
                        Text(message)
                            .foregroundStyle(Theme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Umschichten")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Umschichten") { submit() }
                        .disabled(busy || target == nil || amount.isEmpty)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 280)
        .onAppear {
            source = request.source
            target = request.target
            if let target, case .readyToAssign = request.source, let row = state?.row(target), row.neededCents > 0 {
                amount = Money.number(row.neededCents, style: .exact)
            }
        }
    }

    private func submit() {
        guard let target else { return }
        guard let cents = Money.parse(amount) else {
            message = "Bitte einen gültigen Betrag eingeben, z. B. 25 oder 12,50."
            return
        }
        busy = true
        Task {
            let result = await model.move(householdId: request.householdId, from: source, to: target, cents: cents)
            busy = false
            if let result {
                message = result
            } else {
                dismiss()
            }
        }
    }
}
#endif

import FreiraumKit
import Foundation
import Observation
import UserNotifications
#if os(macOS)
import AppKit
#endif
#if os(iOS)
import BackgroundTasks
import WidgetKit
#endif

/// Zustand der App. Der Server bleibt führend: Nach jeder Aktion wird neu geladen, was sich
/// geändert haben kann, statt lokal nachzurechnen.
@MainActor @Observable
final class AppModel {
    // MARK: Anmeldung

    /// Eingabe im Anmeldebildschirm: Domain oder URL des Backends.
    var serverText: String
    private(set) var person: Person?
    private(set) var service: FreiraumService?
    var isSignedIn: Bool { service != nil && person != nil }

    // MARK: Daten

    private(set) var households: [Household] = []
    private(set) var accounts: [Account] = []
    private(set) var pots: [String: [Pot]] = [:]
    private(set) var budgets: [String: BudgetMonth] = [:]
    /// Ausgleich je gemeinsamem Haushalt
    private(set) var settlements: [String: Settlements] = [:]
    private(set) var pending: [Transaction] = []
    /// Soll und Ist der Einzahlungen im angezeigten Monat, je gemeinsamem Haushalt.
    private(set) var contributions: [String: Contributions] = [:]
    /// Einzahlungsregeln mit Historie, je gemeinsamem Haushalt (geladen, wenn die Ansicht öffnet).
    private(set) var contributionRules: [String: [ContributionRule]] = [:]
    private(set) var shares: Shares?

    // MARK: Auswertungen (iPhone und Mac), Menüleiste (Mac)

    var analyticsPeriod: AnalyticsPeriod = .monat
    /// Aufbereitete Auswertung je Haushalt (für den angezeigten Monat und Zeitraum).
    private(set) var analytics: [String: AnalyticsState] = [:]
    /// Geldfluss je Haushalt, passend zu `analytics`.
    private(set) var flows: [String: MoneyFlow] = [:]
    /// Geldfluss über die eigenen Haushalte (privat → Einzahlung → gemeinsam), gleicher Zeitraum;
    /// nil mit nur einem Haushalt.
    private(set) var personFlow: MoneyFlow?
    private(set) var isLoadingAnalytics = false
    /// Privater Haushalt im laufenden Monat und seine Auffälligkeiten, für die Menüleiste.
    private(set) var menuBarBudget: BudgetMonth?
    private(set) var menuBarAnomalies: [Anomaly] = []
    @ObservationIgnored private var refreshLoop: Task<Void, Never>?

    var selectedHouseholdId: String?
    private(set) var month: YearMonth = .current()

    private(set) var isLoading = false
    private(set) var lastLoaded: Date?
    var errorMessage: String?

    private let defaults = UserDefaults.standard
    private let snapshots = SnapshotStore(directory: AppConfig.sharedDirectory)

    init() {
        let storedServer = defaults.string(forKey: Keys.server)
        serverText = storedServer ?? AppConfig.defaultDomain ?? ""
        if let storedServer, let url = AppConfig.serverURL(from: storedServer), Keychain.loadToken() != nil,
           let name = defaults.string(forKey: Keys.personName), let id = defaults.string(forKey: Keys.personId) {
            service = Self.makeService(url)
            person = Person(id: id, displayName: name)
        }
        startPeriodicRefresh()
    }

    private enum Keys {
        static let server = "server"
        static let personId = "personId"
        static let personName = "personName"
        static let seenPending = "seenPending"
    }

    private static func makeService(_ url: URL) -> FreiraumService {
        FreiraumService(baseURL: url, token: { Keychain.loadToken() })
    }

    // MARK: Abgeleitet

    var selectedHousehold: Household? {
        households.first { $0.id == selectedHouseholdId } ?? households.first
    }

    var privateHousehold: Household? {
        households.first { $0.kind == .privat }
    }

    func household(of transaction: Transaction) -> Household? {
        guard let account = account(transaction.accountId) else { return nil }
        return households.first { $0.id == account.householdId }
    }

    /// Frühester Monat mit Budget (Budgetbeginn des gewählten Haushalts).
    var budgetStartMonth: YearMonth {
        selectedHousehold.flatMap { budgets[$0.id]?.startMonth } ?? YearMonth(year: 2000, month: 1)
    }

    func account(_ id: String) -> Account? {
        accounts.first { $0.id == id }
    }

    func pots(of householdId: String?) -> [Pot] {
        householdId.flatMap { pots[$0] } ?? []
    }

    /// Was beim Zuordnen einer Buchung zur Wahl steht: Töpfe ihres Haushalts, dazu beim
    /// gemeinsamen Konto die eigenen privaten Töpfe und beim privaten die gemeinsamen.
    func targetContext(for transaction: Transaction) -> TargetContext {
        let household = household(of: transaction)
        return TargetContext(
            household: household, households: households, pots: pots, me: person, accounts: accounts(of: household?.id)
        )
    }

    func settlementState(for household: Household) -> SettlementState? {
        guard household.kind == .gemeinsam, let settlements = settlements[household.id] else { return nil }
        return SettlementState(settlements, me: person, today: GermanDates.isoDate(Date()))
    }

    func pendingCount(householdId: String?) -> Int {
        guard let householdId else { return pending.count }
        return pending.filter { self.household(of: $0)?.id == householdId }.count
    }

    /// Die andere Person im gemeinsamen Haushalt.
    func partner(in household: Household) -> Person? {
        household.members.first { $0.id != person?.id }
    }

    func contributionsState(for household: Household) -> ContributionsState? {
        guard household.kind == .gemeinsam, let c = contributions[household.id] else { return nil }
        return ContributionsState(c, me: person?.id)
    }

    func overview(for household: Household) -> OverviewState? {
        guard let budget = budgets[household.id] else { return nil }
        return OverviewState(
            budget: budget, household: household, pots: pots[household.id] ?? [],
            pendingCount: pendingCount(householdId: household.id),
            unrecordedCashCents: unrecordedCash(householdId: household.id)
        )
    }

    /// Konten eines Haushalts.
    func accounts(of householdId: String?) -> [Account] {
        accounts.filter { $0.householdId == householdId }
    }

    /// Abgehobenes Bargeld eines Haushalts, für das noch keine Ausgaben erfasst sind.
    func unrecordedCash(householdId: String) -> Int {
        CashText.unrecordedCents(accounts: accounts, householdId: householdId)
    }

    // MARK: Anmelden und Abmelden

    /// Mit vorhandenem Passkey anmelden.
    func signIn(using passkeys: PasskeyController) async {
        guard let url = validatedServer() else { return }
        let service = Self.makeService(url)
        do {
            let challenge = try await service.loginChallenge()
            let assertion = try await passkeys.login(challenge)
            let session = try await service.login(challenge, result: assertion)
            finishSignIn(session, url: url, service: service)
            await load()
        } catch {
            report(error)
        }
    }

    /// Einladung einlösen: neuen Passkey anlegen und anmelden.
    func register(invitationToken: String, using passkeys: PasskeyController) async {
        guard let url = validatedServer() else { return }
        let token = invitationToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            errorMessage = "Bitte das Einladungs-Token eingeben."
            return
        }
        let service = Self.makeService(url)
        do {
            let challenge = try await service.registrationChallenge(invitationToken: token)
            let registration = try await passkeys.register(challenge)
            let session = try await service.register(challenge, invitationToken: token, result: registration)
            finishSignIn(session, url: url, service: service)
            await load()
        } catch {
            report(error)
        }
    }

    private func validatedServer() -> URL? {
        guard let url = AppConfig.serverURL(from: serverText) else {
            errorMessage = "Bitte die Adresse des Servers eingeben, z. B. freiraum.example.org (nur https)."
            return nil
        }
        errorMessage = nil
        return url
    }

    private func finishSignIn(_ session: Session, url: URL, service: FreiraumService) {
        Keychain.saveToken(session.token)
        defaults.set(url.absoluteString, forKey: Keys.server)
        defaults.set(session.person.id, forKey: Keys.personId)
        defaults.set(session.person.displayName, forKey: Keys.personName)
        self.service = service
        person = session.person
        Task { await Notifications.requestPermission() }
    }

    func signOut(message: String? = nil) async {
        if let service, message == nil {
            try? await service.logout()
        }
        Keychain.deleteToken()
        defaults.removeObject(forKey: Keys.personId)
        defaults.removeObject(forKey: Keys.personName)
        defaults.removeObject(forKey: Keys.seenPending)
        service = nil
        person = nil
        households = []
        accounts = []
        pots = [:]
        budgets = [:]
        settlements = [:]
        pending = []
        contributions = [:]
        contributionRules = [:]
        shares = nil
        analytics = [:]
        flows = [:]
        personFlow = nil
        menuBarBudget = nil
        menuBarAnomalies = []
        selectedHouseholdId = nil
        errorMessage = message
        snapshots.clear()
        reloadWidgets()
        await Notifications.clear()
    }

    // MARK: Laden

    /// Alles neu laden. `notify`: neue wartende Buchungen melden (Hintergrund), sonst gelten sie
    /// als gesehen (die Person hat die App offen).
    func load(notify: Bool = false) async {
        guard let service else { return }
        isLoading = true
        defer { isLoading = false }
        let month = self.month
        do {
            async let householdsCall = service.households()
            async let accountsCall = service.accounts()
            async let pendingCall = service.pendingTransactions()
            let (households, accounts, pending) = try await (householdsCall, accountsCall, pendingCall)

            let perHousehold = try await withThrowingTaskGroup(of: (String, [Pot], BudgetMonth).self) { group in
                for household in households {
                    group.addTask {
                        async let pots = service.pots(householdId: household.id)
                        async let budget = service.budget(householdId: household.id, month: month)
                        return (household.id, try await pots, try await budget)
                    }
                }
                var result: [(String, [Pot], BudgetMonth)] = []
                for try await item in group { result.append(item) }
                return result
            }

            self.households = households.sorted { ($0.kind == .privat ? 0 : 1) < ($1.kind == .privat ? 0 : 1) }
            self.accounts = accounts
            self.pending = pending
            pots = Dictionary(perHousehold.map { ($0.0, $0.1) }, uniquingKeysWith: { a, _ in a })
            budgets = Dictionary(perHousehold.map { ($0.0, $0.2) }, uniquingKeysWith: { a, _ in a })
            if selectedHouseholdId == nil || !households.contains(where: { $0.id == selectedHouseholdId }) {
                selectedHouseholdId = self.households.first?.id
            }
            errorMessage = nil
            try await loadSettlements()
            lastLoaded = Date()
            contributions = await fetchContributions(service, households: households, month: month)
            await afterLoad(notify: notify)
            #if os(macOS)
            await refreshMenuBar()
            #endif
        } catch {
            report(error)
        }
    }

    /// Anderen Monat anzeigen.
    func show(month: YearMonth) async {
        guard month != self.month else { return }
        self.month = month
        budgets = [:]
        contributions = [:]
        await load()
    }

    /// Budget eines Haushalts, Konten (Bargeldbestand) und offene Buchungen neu laden (nach einer
    /// Aktion).
    func reload(householdId: String) async {
        await reload(householdIds: [householdId])
    }

    /// Budgets mehrerer Haushalte, Konten (Bargeldbestand), die offenen Buchungen und den Ausgleich
    /// neu laden. Eine Buchung
    /// über die Haushaltsgrenze (privater Topf vom gemeinsamen Konto und umgekehrt) ändert beide.
    func reload(householdIds: Set<String>) async {
        guard let service else { return }
        let month = self.month
        do {
            async let pendingCall = service.pendingTransactions()
            async let accountsCall = service.accounts()
            let budgets = try await withThrowingTaskGroup(of: BudgetMonth.self) { group in
                for id in householdIds {
                    group.addTask { try await service.budget(householdId: id, month: month) }
                }
                var result: [BudgetMonth] = []
                for try await item in group { result.append(item) }
                return result
            }
            let pending = try await pendingCall
            for budget in budgets { self.budgets[budget.householdId] = budget }
            self.pending = pending
            self.accounts = try await accountsCall
            try await loadSettlements()
            // Eine bestätigte Einzahlung ändert das Ist.
            let shared = households.filter { householdIds.contains($0.id) && $0.kind == .gemeinsam }
            if !shared.isEmpty {
                let fresh = await fetchContributions(service, households: shared, month: month)
                contributions.merge(fresh, uniquingKeysWith: { _, new in new })
            }
            await afterLoad(notify: false)
        } catch {
            report(error)
        }
    }

    /// Ausgleich aller gemeinsamen Haushalte laden.
    private func loadSettlements() async throws {
        guard let service else { return }
        var result: [String: Settlements] = [:]
        for household in households where household.kind == .gemeinsam {
            result[household.id] = try await service.settlements(householdId: household.id)
        }
        settlements = result
    }

    /// Haushalte, deren Budget eine Zuordnung berührt: der des Kontos und die der Töpfe.
    private func householdIds(of transaction: Transaction, targets: [SplitTarget]) -> Set<String> {
        var ids = Set([household(of: transaction)?.id].compactMap { $0 })
        for case let .pot(potId) in targets {
            if let owner = pots.first(where: { $0.value.contains { $0.id == potId } })?.key { ids.insert(owner) }
        }
        return ids
    }

    /// Soll und Ist der gemeinsamen Haushalte. Ein Fehler hier lässt das Budget stehen und
    /// zeigt nur die Meldung.
    private func fetchContributions(
        _ service: FreiraumService, households: [Household], month: YearMonth
    ) async -> [String: Contributions] {
        var result: [String: Contributions] = [:]
        for household in households where household.kind == .gemeinsam {
            do {
                result[household.id] = try await service.contributions(householdId: household.id, month: month)
            } catch {
                report(error)
            }
        }
        return result
    }

    private func afterLoad(notify: Bool) async {
        if month == .current(), let household = privateHousehold ?? households.first, let budget = budgets[household.id] {
            menuBarBudget = budget
        }
        // Widget: privater Haushalt im laufenden Monat.
        if month == .current(), let household = privateHousehold, let budget = budgets[household.id] {
            let snapshot = WidgetSnapshot(
                budget: budget, household: household, pendingCount: pendingCount(householdId: household.id)
            )
            try? snapshots.save(snapshot)
            reloadWidgets()
        }
        let ids = Set(pending.map(\.id))
        let seen = Set(defaults.stringArray(forKey: Keys.seenPending) ?? [])
        if notify {
            let withSuggestions = pending.filter { $0.suggestion != nil }.count
            let result = PendingNotifier().evaluate(pendingIds: ids, withSuggestions: withSuggestions, seen: seen)
            if let notice = result.notice { await Notifications.post(notice) }
            defaults.set(Array(result.seen), forKey: Keys.seenPending)
        } else {
            defaults.set(Array(ids), forKey: Keys.seenPending)
        }
        await Notifications.setBadge(pending.count)
    }

    private func reloadWidgets() {
        #if os(iOS)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }

    private func report(_ error: any Error) {
        if error is CancellationError { return }
        if let api = error as? APIError, case let .unauthorized(message) = api {
            Task { await signOut(message: "Abgemeldet: \(message)") }
            return
        }
        errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    // MARK: Aktionen

    /// Vorschlag übernehmen.
    func confirm(_ transaction: Transaction) async -> Bool {
        await perform(transaction, targets: transaction.suggestion.map { [$0.target] } ?? []) { service in
            _ = try await service.confirm(transactionId: transaction.id)
        }
    }

    /// Selbst zuordnen oder aufteilen. Eine einfache Korrektur lernt der Server als Regel.
    func assign(_ transaction: Transaction, splits: [Split]) async -> Bool {
        await perform(transaction, targets: splits.map(\.target)) { service in
            _ = try await service.setSplits(transactionId: transaction.id, splits: splits)
        }
    }

    /// Abhebung als Umbuchung ins Bargeldkonto des Haushalts buchen (legt es bei Bedarf an).
    /// Das Budget ändert sich dadurch nicht; erst erfasste Barausgaben belasten Töpfe.
    func bookAsCash(_ transaction: Transaction) async -> Bool {
        guard let service, let household = household(of: transaction) else { return false }
        do {
            let cash = try await cashAccount(householdId: household.id, service: service)
            let split = Split(target: .transferTo(cash.id), amountCents: transaction.amountCents)
            _ = try await service.setSplits(transactionId: transaction.id, splits: [split])
            pending.removeAll { $0.id == transaction.id }
            await reload(householdId: household.id)
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Bargeldkonto des Haushalts; beim ersten Mal wird eins angelegt („Bargeld“).
    private func cashAccount(householdId: String, service: FreiraumService) async throws -> Account {
        if let cash = accounts.first(where: { $0.householdId == householdId && $0.source == .bar }) {
            return cash
        }
        let created = try await service.createCashAccount(householdId: householdId)
        accounts.append(created)
        return created
    }

    /// Barausgabe erfassen; legt beim ersten Mal ein Bargeldkonto im Haushalt an.
    func recordCash(_ expense: CashExpense, householdId: String) async -> Bool {
        guard let service else { return false }
        do {
            let cash = try await cashAccount(householdId: householdId, service: service)
            _ = try await service.recordCashExpense(accountId: cash.id, expense: expense)
            await reload(householdId: householdId)
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Zuweisung eines Topfs im angezeigten Monat setzen.
    func setAssignment(potId: String, householdId: String, cents: Int) async -> Bool {
        guard let service else { return false }
        do {
            try await service.assign(householdId: householdId, month: month, potId: potId, assignedCents: cents)
            await reload(householdId: householdId)
            return true
        } catch {
            report(error)
            return false
        }
    }

    // MARK: Töpfe einrichten

    /// Topf anlegen. Ein Erst-ich-Topf füllt sich sofort aus „Noch ohne Aufgabe“.
    func createPot(_ input: PotInput, householdId: String) async -> Bool {
        await changePots(householdId: householdId) { service in
            _ = try await service.createPot(householdId: householdId, input: input)
        }
    }

    /// Topf ändern, archivieren oder wiederherstellen.
    func updatePot(_ pot: Pot, changes: PotChanges) async -> Bool {
        guard !changes.isEmpty else { return true }
        return await changePots(householdId: pot.householdId) { service in
            _ = try await service.updatePot(id: pot.id, changes: changes)
        }
    }

    /// Reihenfolge aller aktiven Töpfe festlegen.
    func reorderPots(householdId: String, potIds: [String]) async -> Bool {
        await changePots(householdId: householdId) { service in
            _ = try await service.reorderPots(householdId: householdId, potIds: potIds)
        }
    }

    /// Archivierte Töpfe eines Haushalts; leer bei Fehler (Meldung in `errorMessage`).
    func archivedPots(householdId: String) async -> [Pot] {
        guard let service else { return [] }
        do {
            return try await service.archivedPots(householdId: householdId)
        } catch {
            report(error)
            return []
        }
    }

    /// Aktion an Töpfen ausführen, danach Töpfe und Budget des Haushalts neu laden.
    private func changePots(householdId: String, _ action: (FreiraumService) async throws -> Void) async -> Bool {
        guard let service else { return false }
        do {
            try await action(service)
            pots[householdId] = try await service.pots(householdId: householdId)
            await reload(householdId: householdId)
            return true
        } catch {
            report(error)
            return false
        }
    }

    // MARK: Ausgleich von Hand

    /// Eigenen Ausgleich von Hand verbuchen (bar erhalten) oder mit der Einzahlung verrechnen.
    func recordSettlement(householdId: String, input: SettlementInput) async -> Bool {
        await changeSettlements(householdId: householdId, offset: input.kind == .verrechnung) { service in
            // Die Antwort ist schon der Stand danach.
            self.settlements[householdId] = try await service.recordSettlement(householdId: householdId, input: input)
            return false
        }
    }

    /// Eigenen von Hand verbuchten Ausgleich zurücknehmen.
    func deleteSettlement(_ row: SettlementState.ManualRow, householdId: String) async -> Bool {
        await changeSettlements(householdId: householdId, offset: row.isOffset) { service in
            try await service.deleteSettlement(id: row.id)
            return true
        }
    }

    /// Aktion am Ausgleich ausführen (liefert, ob der Ausgleich neu zu laden ist). Eine
    /// Verrechnung ändert Ist und Budget im gemeinsamen und im privaten Haushalt; `reload` lädt
    /// beide samt Ausgleich und Einzahlungen neu. Ein Fehler beim Nachladen zeigt nur die Meldung:
    /// Gebucht ist dann schon, ein zweiter Versuch würde doppelt buchen.
    private func changeSettlements(
        householdId: String, offset: Bool, _ action: (FreiraumService) async throws -> Bool
    ) async -> Bool {
        guard let service else { return false }
        errorMessage = nil
        let needsSettlements: Bool
        do {
            needsSettlements = try await action(service)
        } catch {
            report(error)
            return false
        }
        if offset {
            await reload(householdIds: Set([householdId, privateHousehold?.id].compactMap { $0 }))
        } else if needsSettlements {
            do { try await loadSettlements() } catch { report(error) }
        }
        return true
    }

    // MARK: Einzahlungen ins Gemeinsame

    /// Regeln mit Historie und Freigaben laden (für die Ansicht „Einzahlungen“).
    func loadContributionDetails(householdId: String) async {
        guard let service else { return }
        do {
            async let rules = service.contributionRules(householdId: householdId)
            async let shares = service.shares()
            let (r, s) = try await (rules, shares)
            contributionRules[householdId] = r
            self.shares = s
        } catch {
            report(error)
        }
    }

    /// Eigene Regel ab `from` setzen.
    func setContributionRule(householdId: String, from: YearMonth, rule: ContributionRuleInput) async -> Bool {
        await changeContributions(householdId: householdId) { service in
            _ = try await service.setContributionRule(householdId: householdId, from: from, rule: rule)
        }
    }

    /// Eigene Regel mit Startmonat `from` löschen; die vorige gilt wieder.
    func deleteContributionRule(householdId: String, from: YearMonth) async -> Bool {
        await changeContributions(householdId: householdId) { service in
            try await service.deleteContributionRule(householdId: householdId, from: from)
        }
    }

    /// Freigabe erteilen oder zurücknehmen; danach Freigaben neu laden.
    func setShare(_ scope: ShareScope, to personId: String, granted: Bool) async -> Bool {
        guard let service else { return false }
        do {
            if granted {
                try await service.grantShare(scope, to: personId)
            } else {
                try await service.revokeShare(scope, from: personId)
            }
            shares = try await service.shares()
            return true
        } catch {
            report(error)
            return false
        }
    }

    /// Aktion an Regeln ausführen, danach Regeln sowie Soll und Ist des Haushalts neu laden.
    private func changeContributions(householdId: String, _ action: (FreiraumService) async throws -> Void) async -> Bool {
        guard let service else { return false }
        do {
            try await action(service)
            async let rules = service.contributionRules(householdId: householdId)
            async let current = service.contributions(householdId: householdId, month: month)
            let (r, c) = try await (rules, current)
            contributionRules[householdId] = r
            contributions[householdId] = c
            return true
        } catch {
            report(error)
            return false
        }
    }

    private func perform(
        _ transaction: Transaction, targets: [SplitTarget], _ action: (FreiraumService) async throws -> Void
    ) async -> Bool {
        guard let service else { return false }
        do {
            try await action(service)
            let affected = householdIds(of: transaction, targets: targets)
            pending.removeAll { $0.id == transaction.id }
            if !affected.isEmpty {
                await reload(householdIds: affected)
            }
            return true
        } catch {
            report(error)
            return false
        }
    }

    // MARK: Budgetbeginn und Kontostände

    /// Budgetbeginn, Anfangsbestand und Kontostände; nil bei Fehler (Meldung in `errorMessage`).
    func budgetStart(householdId: String) async -> BudgetStart? {
        guard let service else { return nil }
        do {
            return try await service.budgetStart(householdId: householdId)
        } catch {
            reportSetup(error)
            return nil
        }
    }

    /// Startmonat festlegen. Abgelehnt (409), wenn schon ein Monat abgeschlossen ist oder vor dem
    /// neuen Start Töpfe gefüllt sind.
    func setBudgetStart(_ month: YearMonth, householdId: String) async -> BudgetStart? {
        await changeStart(householdId: householdId) { service in
            try await service.setBudgetStart(householdId: householdId, month: month)
        }
    }

    /// Kontostand von Hand erfassen; daraus folgt der Anfangsbestand.
    func setBalance(accountId: String, cents: Int, date: String, householdId: String) async -> BudgetStart? {
        await changeStart(householdId: householdId) { service in
            try await service.setBalance(accountId: accountId, cents: cents, date: date)
        }
    }

    /// Konto im Haushalt anlegen (z. B. Girokonto, bevor der Kontoimport läuft).
    func addAccount(name: String, source: Account.Source, householdId: String) async -> BudgetStart? {
        await changeStart(householdId: householdId) { service in
            let account = try await service.createAccount(householdId: householdId, name: name, source: source)
            self.accounts.append(account)
            return try await service.budgetStart(householdId: householdId)
        }
    }

    /// Aktion am Budgetbeginn ausführen, danach das Budget des Haushalts neu laden
    /// („Noch ohne Aufgabe“ ändert sich mit dem Anfangsbestand).
    private func changeStart(
        householdId: String, _ action: (FreiraumService) async throws -> BudgetStart
    ) async -> BudgetStart? {
        guard let service else { return nil }
        errorMessage = nil
        do {
            let start = try await action(service)
            await reload(householdId: householdId)
            return start
        } catch {
            reportSetup(error)
            return nil
        }
    }

    /// Wie `report`, aber mit Erklärung, was bei einem Konflikt zu tun ist.
    private func reportSetup(_ error: any Error) {
        if let api = error as? APIError, case .unauthorized = api {
            report(error)
        } else if !(error is CancellationError) {
            errorMessage = BudgetStartMessages.explain(error)
        }
    }

    // MARK: Planung (Mac)

    func planning(for household: Household) -> PlanningState? {
        guard let budget = budgets[household.id] else { return nil }
        return PlanningState(budget: budget, pots: pots[household.id] ?? [])
    }

    /// Zuweisung eines Topfs im angezeigten Monat setzen. Liefert nil bei Erfolg, sonst die
    /// Meldung des Servers (z. B. „Noch ohne Aufgabe“ würde negativ), für die Anzeige am Feld.
    func assign(householdId: String, potId: String, cents: Int) async -> String? {
        await changeBudget(householdId: householdId) { service, month in
            _ = try await service.setAssignment(householdId: householdId, month: month, potId: potId, assignedCents: cents)
        }
    }

    /// Geld umschichten: erst die Quelle senken, dann das Ziel erhöhen. Scheitert das Erhöhen,
    /// nimmt der Dienst das Senken zurück. Liefert nil bei Erfolg, sonst die Meldung.
    func move(householdId: String, from source: MoveMoney.Source, to potId: String, cents: Int) async -> String? {
        guard let budget = budgets[householdId] else { return "Das Budget ist noch nicht geladen." }
        let request: MoveMoney.Request
        do {
            request = try MoveMoney.request(in: budget, from: source, to: potId, amountCents: cents)
        } catch {
            return (error as? MoveMoney.Problem)?.description ?? String(describing: error)
        }
        return await changeBudget(householdId: householdId) { service, month in
            _ = try await service.move(householdId: householdId, month: month, request)
        }
    }

    /// Angezeigten Monat abschließen (der Server prüft Reihenfolge und offene Buchungen).
    func closeMonth(householdId: String) async -> String? {
        await changeBudget(householdId: householdId) { service, month in
            _ = try await service.closeMonth(householdId: householdId, month: month)
        }
    }

    /// Abschluss des angezeigten Monats zurücknehmen (nur der zuletzt abgeschlossene).
    func reopenMonth(householdId: String) async -> String? {
        await changeBudget(householdId: householdId) { service, month in
            _ = try await service.reopenMonth(householdId: householdId, month: month)
        }
    }

    /// Aktion am Budget ausführen und danach neu laden, auch nach einem Fehler (der Stand kann
    /// sich teilweise geändert haben). Eine abgelaufene Sitzung meldet ab.
    private func changeBudget(
        householdId: String, _ action: (FreiraumService, YearMonth) async throws -> Void
    ) async -> String? {
        guard let service else { return "Nicht angemeldet." }
        var message: String?
        do {
            try await action(service, month)
        } catch {
            if let api = error as? APIError, case .unauthorized = api {
                report(error)
                return nil
            }
            message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        await reload(householdId: householdId)
        return message
    }

    // MARK: Auswertungen

    /// Auswertung eines Haushalts für den angezeigten Monat und `analyticsPeriod` laden. Der
    /// Zeitraum beginnt frühestens mit dem Budgetbeginn (ADR 0005).
    func loadAnalytics(householdId: String) async {
        guard let service else { return }
        let to = month
        let start = budgets[householdId]?.startMonth
        let period = analyticsPeriod.range(to: to, budgetStart: start)
        let history = AnalyticsPeriod.history(to: to, budgetStart: start)
        isLoadingAnalytics = true
        defer { isLoadingAnalytics = false }
        do {
            async let summary = service.metrics(householdId: householdId, from: period.lowerBound, to: period.upperBound)
            async let past = service.metrics(householdId: householdId, from: history.lowerBound, to: history.upperBound)
            async let flow = service.flow(householdId: householdId, from: period.lowerBound, to: period.upperBound)
            async let anomalies = service.anomalies(householdId: householdId, month: to)
            async let goals = service.goals(householdId: householdId)
            async let ownership = service.ownershipCosts(householdId: householdId, from: period.lowerBound, to: period.upperBound)
            let (s, h, f, a, g, o) = try await (summary, past, flow, anomalies, goals, ownership)
            flows[householdId] = f
            analytics[householdId] = AnalyticsState(summary: s, history: h, flow: f, anomalies: a, goals: g, ownership: o)
        } catch {
            report(error)
        }
        // Über Haushalte hinweg nur mit gemeinsamem Haushalt und nur am Mac (Sankey); ein Fehler
        // hier lässt den Rest stehen.
        #if os(macOS)
        if let person, households.count > 1 {
            personFlow = try? await service.personFlow(personId: person.id, from: period.lowerBound, to: period.upperBound)
        } else {
            personFlow = nil
        }
        #endif
    }

    // MARK: Menüleiste (Mac)

    /// Privater Haushalt im laufenden Monat, alle wartenden Buchungen, nächste Auffälligkeit.
    var menuBar: MenuBarState {
        MenuBarState(
            budget: menuBarBudget, household: privateHousehold ?? households.first,
            pendingCount: pending.count, anomalies: menuBarAnomalies
        )
    }

    /// Budget und Auffälligkeiten des laufenden Monats für die Menüleiste laden. Fehler zeigt
    /// sie nicht an (die Menüleiste bleibt beim letzten Stand), nur eine abgelaufene Sitzung.
    func refreshMenuBar() async {
        guard let service, let household = privateHousehold ?? households.first else { return }
        let current = YearMonth.current()
        do {
            if month == current, let budget = budgets[household.id] {
                menuBarBudget = budget
            } else {
                menuBarBudget = try await service.budget(householdId: household.id, month: current)
            }
            menuBarAnomalies = try await service.anomalies(householdId: household.id, month: current)
        } catch {
            if let api = error as? APIError, case .unauthorized = api { report(error) }
        }
    }

    /// Am Mac läuft die App mit der Menüleiste weiter, auch ohne Fenster: alle 15 Minuten neu
    /// laden. Neue wartende Buchungen werden gemeldet, solange die App nicht im Vordergrund ist.
    private func startPeriodicRefresh() {
        #if os(macOS)
        guard refreshLoop == nil else { return }
        refreshLoop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15 * 60))
                guard let self else { return }
                if self.isSignedIn {
                    await self.load(notify: !NSApplication.shared.isActive)
                }
            }
        }
        #endif
    }

    // MARK: Hintergrund

    /// Hintergrundabruf (iOS): laden, neue Buchungen melden, Widget aktualisieren.
    func backgroundRefresh() async {
        scheduleBackgroundRefresh()
        if month != .current() { month = .current() }
        await load(notify: true)
    }

    func scheduleBackgroundRefresh() {
        #if os(iOS)
        let request = BGAppRefreshTaskRequest(identifier: AppConfig.refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        try? BGTaskScheduler.shared.submit(request)
        #endif
    }
}

/// Lokale Benachrichtigungen „Buchungen warten“. Der Server schickt (noch) keine Pushes; die App
/// fragt im Hintergrundabruf selbst nach (siehe ADR 0004).
enum Notifications {
    static let identifier = "buchungen-warten"

    static func requestPermission() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    }

    static func post(_ notice: PendingNotifier.Notice) async {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        content.threadIdentifier = identifier
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    static func setBadge(_ count: Int) async {
        try? await UNUserNotificationCenter.current().setBadgeCount(count)
    }

    static func clear() async {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
        try? await center.setBadgeCount(0)
    }
}

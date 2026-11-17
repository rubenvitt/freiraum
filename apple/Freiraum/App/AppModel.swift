import FreiraumKit
import Foundation
import Observation
import UserNotifications
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
    private(set) var pending: [Transaction] = []
    /// Soll und Ist der Einzahlungen im angezeigten Monat, je gemeinsamem Haushalt.
    private(set) var contributions: [String: Contributions] = [:]
    /// Einzahlungsregeln mit Historie, je gemeinsamem Haushalt (geladen, wenn die Ansicht öffnet).
    private(set) var contributionRules: [String: [ContributionRule]] = [:]
    private(set) var shares: Shares?
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
            pendingCount: pendingCount(householdId: household.id)
        )
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
        pending = []
        contributions = [:]
        contributionRules = [:]
        shares = nil
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
            lastLoaded = Date()
            contributions = await fetchContributions(service, households: households, month: month)
            await afterLoad(notify: notify)
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

    /// Nur das Budget eines Haushalts und die offenen Buchungen neu laden (nach einer Aktion).
    func reload(householdId: String) async {
        guard let service else { return }
        do {
            async let budget = service.budget(householdId: householdId, month: month)
            async let pending = service.pendingTransactions()
            let (b, p) = try await (budget, pending)
            budgets[householdId] = b
            self.pending = p
            // Eine bestätigte Einzahlung ändert das Ist.
            if let household = households.first(where: { $0.id == householdId && $0.kind == .gemeinsam }) {
                let fresh = await fetchContributions(service, households: [household], month: month)
                contributions.merge(fresh, uniquingKeysWith: { _, new in new })
            }
            await afterLoad(notify: false)
        } catch {
            report(error)
        }
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
        await perform(householdOf: transaction) { service in
            _ = try await service.confirm(transactionId: transaction.id)
        }
    }

    /// Selbst zuordnen oder aufteilen. Eine einfache Korrektur lernt der Server als Regel.
    func assign(_ transaction: Transaction, splits: [Split]) async -> Bool {
        await perform(householdOf: transaction) { service in
            _ = try await service.setSplits(transactionId: transaction.id, splits: splits)
        }
    }

    /// Barausgabe erfassen; legt beim ersten Mal ein Bargeldkonto im Haushalt an.
    func recordCash(_ expense: CashExpense, householdId: String) async -> Bool {
        guard let service else { return false }
        do {
            var cash = accounts.first { $0.householdId == householdId && $0.source == .bar }
            if cash == nil {
                let created = try await service.createCashAccount(householdId: householdId)
                accounts.append(created)
                cash = created
            }
            guard let cash else { return false }
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

    private func perform(householdOf transaction: Transaction, _ action: (FreiraumService) async throws -> Void) async -> Bool {
        guard let service else { return false }
        do {
            try await action(service)
            pending.removeAll { $0.id == transaction.id }
            if let household = household(of: transaction) {
                await reload(householdId: household.id)
            }
            return true
        } catch {
            report(error)
            return false
        }
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

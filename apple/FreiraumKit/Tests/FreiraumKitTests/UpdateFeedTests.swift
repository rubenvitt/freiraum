import Foundation
import Testing
@testable import FreiraumKit

// Alle Adressen sind erfunden bzw. öffentlich.

@Suite struct UpdateFeedTests {
    @Test(arguments: [
        nil, "", "  ", "$(FREIRAUM_UPDATE_FEED)", "http://x/appcast.xml",
    ] as [String?])
    func unbrauchbareAdressenLiefernNil(raw: String?) {
        #expect(UpdateFeed.url(from: raw) == nil)
    }

    @Test func httpsAdresseWirdUebernommen() {
        let raw = "https://github.com/rubenvitt/freiraum/releases/latest/download/appcast.xml"
        #expect(UpdateFeed.url(from: raw)?.absoluteString == raw)
    }

    @Test func umgebendeLeerzeichenWerdenEntfernt() {
        #expect(UpdateFeed.url(from: " https://x.test/appcast.xml\n")?.absoluteString == "https://x.test/appcast.xml")
    }
}

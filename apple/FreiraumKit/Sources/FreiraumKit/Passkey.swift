import Foundation

/// Base64url ohne Auffüllzeichen, wie WebAuthn es verwendet.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let rest = s.count % 4
        if rest == 1 { return nil }
        if rest > 0 { s += String(repeating: "=", count: 4 - rest) }
        return Data(base64Encoded: s)
    }
}

/// Was die App für `ASAuthorizationPlatformPublicKeyCredentialProvider` zur Registrierung braucht.
public struct PasskeyRegistrationChallenge: Sendable, Hashable {
    public let challengeId: String
    public let relyingPartyId: String
    public let challenge: Data
    public let userId: Data
    public let userName: String
}

/// Was die App zur Anmeldung braucht.
public struct PasskeyLoginChallenge: Sendable, Hashable {
    public let challengeId: String
    public let relyingPartyId: String
    public let challenge: Data
}

/// Ergebnis der Registrierung auf dem Gerät (Rohdaten aus AuthenticationServices).
public struct PasskeyRegistration: Sendable {
    public let credentialId: Data
    public let clientDataJSON: Data
    public let attestationObject: Data

    public init(credentialId: Data, clientDataJSON: Data, attestationObject: Data) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.attestationObject = attestationObject
    }
}

/// Ergebnis der Anmeldung auf dem Gerät (Rohdaten aus AuthenticationServices).
public struct PasskeyAssertion: Sendable {
    public let credentialId: Data
    public let clientDataJSON: Data
    public let authenticatorData: Data
    public let signature: Data
    public let userId: Data?

    public init(credentialId: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userId: Data?) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signature = signature
        self.userId = userId
    }
}

/// Angemeldete Sitzung: Bearer-Token und Person.
public struct Session: Sendable, Hashable, Codable {
    public let token: String
    public let expiresAt: Date
    public let person: Person

    public init(token: String, expiresAt: Date, person: Person) {
        self.token = token
        self.expiresAt = expiresAt
        self.person = person
    }
}

import AuthenticationServices
import FreiraumKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Passkey-Dialog des Systems (Face ID / Touch ID) als async-Aufrufe.
/// Voraussetzung: Associated Domain `webcredentials:<Domain>` und apple-app-site-association
/// auf dem Server (Backend: Umgebungsvariable APPLE_APP_IDS).
@MainActor
final class PasskeyController: NSObject {
    private var continuation: CheckedContinuation<ASAuthorization, any Error>?

    func register(_ challenge: PasskeyRegistrationChallenge) async throws -> PasskeyRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: challenge.relyingPartyId)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge.challenge, name: challenge.userName, userID: challenge.userId
        )
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
              let attestation = credential.rawAttestationObject
        else { throw PasskeyError.unexpected }
        return PasskeyRegistration(
            credentialId: credential.credentialID,
            clientDataJSON: credential.rawClientDataJSON,
            attestationObject: attestation
        )
    }

    func login(_ challenge: PasskeyLoginChallenge) async throws -> PasskeyAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: challenge.relyingPartyId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge.challenge)
        let authorization = try await perform(request)
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyError.unexpected
        }
        return PasskeyAssertion(
            credentialId: credential.credentialID,
            clientDataJSON: credential.rawClientDataJSON,
            authenticatorData: credential.rawAuthenticatorData,
            signature: credential.signature,
            userId: credential.userID
        )
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        continuation?.resume(throwing: CancellationError())
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<ASAuthorization, any Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}

enum PasskeyError: LocalizedError {
    case unexpected

    var errorDescription: String? {
        "Der Passkey-Dialog hat keine verwertbare Antwort geliefert."
    }
}

extension PasskeyController: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated {
            finish(.success(authorization))
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        let canceled = (error as? ASAuthorizationError)?.code == .canceled
        let message = Self.message(for: error)
        let failure: any Error
        if canceled {
            failure = CancellationError()
        } else {
            failure = PasskeyFailure(message: message)
        }
        MainActor.assumeIsolated {
            finish(.failure(failure))
        }
    }

    nonisolated private static func message(for error: any Error) -> String {
        guard let error = error as? ASAuthorizationError else { return error.localizedDescription }
        switch error.code {
        case .notHandled, .failed:
            return "Der Passkey ließ sich nicht verwenden. Stimmt die Server-Adresse (Associated Domain)?"
        case .invalidResponse:
            return "Ungültige Antwort beim Passkey."
        default:
            return error.localizedDescription
        }
    }
}

struct PasskeyFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

extension PasskeyController: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            #if os(iOS)
            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
            return windows.first { $0.isKeyWindow } ?? windows.first ?? ASPresentationAnchor()
            #else
            return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
            #endif
        }
    }
}

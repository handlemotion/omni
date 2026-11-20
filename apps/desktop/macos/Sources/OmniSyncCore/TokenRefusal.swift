import Foundation

/// What a token endpoint's refusal of a refresh means (RFC 6749 section 5.2). Only an answer
/// that says the grant itself is gone signs the person out; anything else keeps the grant on
/// this computer and the call that needed it fails as "try again later".
public enum TokenRefusal: Equatable, Sendable {
    /// `400 invalid_grant` (revoked, expired, or its refresh token already used) or `401`
    /// (the client was refused): sign in again in the app.
    case signedOut
    /// Rate limited, timed out, a server failure, or a `400` for any other reason.
    case tryLater

    public init(status: Int, body: Data?) {
        switch status {
        case 401: self = .signedOut
        case 400: self = Self.error(in: body) == "invalid_grant" ? .signedOut : .tryLater
        default: self = .tryLater
        }
    }

    /// The OAuth `error` field, or a Better Auth `code` when it answers in its own shape.
    private static func error(in body: Data?) -> String? {
        struct Body: Decodable {
            let error: String?
            let code: String?
        }
        guard let body, let decoded = try? JSONDecoder().decode(Body.self, from: body) else { return nil }
        return (decoded.error ?? decoded.code)?.lowercased()
    }
}

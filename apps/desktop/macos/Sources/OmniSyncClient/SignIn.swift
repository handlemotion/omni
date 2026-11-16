import CryptoKit
import Foundation

/// Sync's own sign-in (ADR 0043 decision 5): the first-party `omni-desktop` client with PKCE.
/// `begin` keeps the verifier in the App Group container and answers the URL to open in the app
/// window, where the person is already signed in; the server redirects to
/// `omni://oauth/callback?code=&state=`, and `finish` trades that code for the tokens.
public struct SignIn: Codable, Equatable, Sendable {
    public let origin: URL
    public let verifier: String
    public let state: String

    public static let fileName = "sign-in.json"
    public static let redirect = "omni://oauth/callback"

    /// A new sign-in for `origin`, saved so the callback can finish it in another process.
    public static func begin(origin: URL, container: URL) throws -> (SignIn, URL) {
        let signIn = SignIn(origin: origin, verifier: random(), state: random())
        try JSONEncoder().encode(signIn).write(to: container.appendingPathComponent(fileName), options: .atomic)
        var start = URLComponents(url: origin.appendingPathComponent("api/storage/sync/authorize"), resolvingAgainstBaseURL: false)!
        start.queryItems = [
            URLQueryItem(name: "code_challenge", value: base64url(Data(SHA256.hash(data: Data(signIn.verifier.utf8))))),
            URLQueryItem(name: "state", value: signIn.state),
        ]
        return (signIn, start.url!)
    }

    /// Trades the callback's code for tokens. A callback whose state is not the saved one is
    /// refused: it was not started here.
    public static func finish(callback: URL, container: URL, session: URLSession = .shared) async throws -> (SignIn, SyncTokens) {
        let file = container.appendingPathComponent(fileName)
        guard let saved = try? JSONDecoder().decode(SignIn.self, from: Data(contentsOf: file)) else {
            throw TokenError.signedOut
        }
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard query.first(where: { $0.name == "state" })?.value == saved.state,
              let code = query.first(where: { $0.name == "code" })?.value
        else { throw TokenError.signedOut }
        try? FileManager.default.removeItem(at: file)

        var request = URLRequest(url: saved.origin.appendingPathComponent("api/auth/oauth2/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.httpBody = formBody([
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect),
            ("client_id", "omni-desktop"),
            ("code_verifier", saved.verifier),
            ("resource", saved.origin.appendingPathComponent("api/storage/sync").absoluteString),
        ])
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw TokenError.signedOut }
        return (saved, try TokenStore.tokens(from: data, keeping: nil))
    }

    private static func random() -> String {
        base64url(Data((0..<32).map { _ in UInt8.random(in: 0...255) }))
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

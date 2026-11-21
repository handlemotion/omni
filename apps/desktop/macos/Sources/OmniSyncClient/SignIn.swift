import CryptoKit
import Foundation

/// Sync's own sign-in: the first-party `omni-desktop` client with PKCE.
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
    public static func finish(callback: URL, container: URL, session: URLSession = SyncClient.session) async throws -> (SignIn, SyncTokens) {
        let file = container.appendingPathComponent(fileName)
        guard let saved = try? JSONDecoder().decode(SignIn.self, from: Data(contentsOf: file)) else {
            throw SignInRefused(status: 0, error: "no sign-in was started here")
        }
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard query.first(where: { $0.name == "state" })?.value == saved.state,
              let code = query.first(where: { $0.name == "code" })?.value
        else {
            let error = query.first(where: { $0.name == "error" })?.value
            throw SignInRefused(status: 0, error: error ?? "the callback's state is not this sign-in's")
        }
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
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw SignInRefused(status: status, error: OAuthError.code(in: data)) }
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

/// Why the sync sign-in did not finish: the token endpoint's status and OAuth `error`, or the
/// step that refused. Says what failed, never a code or a token.
public struct SignInRefused: Error, CustomStringConvertible {
    public let status: Int
    public let error: String?
    public var description: String { "sync sign-in refused (status \(status), \(error ?? "no error code"))" }
}

enum OAuthError {
    /// The `error` field of an OAuth error body.
    static func code(in data: Data) -> String? {
        struct Body: Decodable { let error: String? }
        return (try? JSONDecoder().decode(Body.self, from: data))?.error
    }
}

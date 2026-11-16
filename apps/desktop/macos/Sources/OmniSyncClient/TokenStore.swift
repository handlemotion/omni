import Foundation
import Security

/// The sync grant: an OAuth access token for `/api/storage/sync` and the refresh token that
/// renews it (client `omni-desktop`, ADR 0043 decision 5). Never logged.
public struct SyncTokens: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    /// Unix seconds; refreshed a minute early.
    public var expiresAt: Double

    public init(accessToken: String, refreshToken: String, expiresAt: Double) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }

    var expiresSoon: Bool { expiresAt - 60 <= Date().timeIntervalSince1970 }
}

public enum TokenError: Error, Equatable {
    /// No grant in the keychain, or the server refused the refresh: sign in again in the app.
    case signedOut
    case keychain(OSStatus)
}

/// Where `SyncClient` gets its bearer token.
public protocol AccessTokenSource: Sendable {
    /// A token to send now.
    func accessToken() async throws -> String
    /// A new token after the server refused `rejected` with `401`.
    func refresh(rejected: String) async throws -> String
}

/// The tokens in the data protection keychain, in the access group the app and the extension
/// share. Both refresh, so a refresh holds a lock file in the App Group container and reads the
/// keychain again once it has it: whoever got there first already wrote a new pair.
public final class TokenStore: AccessTokenSource {
    private let identity: SharedIdentity
    private let settings: @Sendable () -> SyncSettings?
    private let session: URLSession

    public init(identity: SharedIdentity, settings: @escaping @Sendable () -> SyncSettings?, session: URLSession = .shared) {
        self.identity = identity
        self.settings = settings
        self.session = session
    }

    /// An access token to send, refreshed first when it is about to expire.
    public func accessToken() async throws -> String {
        guard let tokens = try read() else { throw TokenError.signedOut }
        if !tokens.expiresSoon { return tokens.accessToken }
        return try await refresh(rejected: tokens.accessToken)
    }

    /// A new access token after the server refused `rejected` with `401`. If another process
    /// already replaced it, that one is used and no refresh is sent.
    public func refresh(rejected: String) async throws -> String {
        guard let lockURL = identity.container?.appendingPathComponent("token.lock") else {
            throw TokenError.signedOut
        }
        let lock = try FileLock(url: lockURL)
        defer { lock.unlock() }
        guard let tokens = try read() else { throw TokenError.signedOut }
        if tokens.accessToken != rejected, !tokens.expiresSoon { return tokens.accessToken }
        let fresh = try await exchange(tokens.refreshToken)
        try write(fresh)
        return fresh.accessToken
    }

    private func exchange(_ refreshToken: String) async throws -> SyncTokens {
        guard let settings = settings() else { throw TokenError.signedOut }
        var request = URLRequest(url: settings.origin.appendingPathComponent("api/auth/oauth2/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "grant_type", value: "refresh_token"),
            URLQueryItem(name: "refresh_token", value: refreshToken),
            URLQueryItem(name: "client_id", value: "omni-desktop"),
            URLQueryItem(name: "resource", value: settings.api.absoluteString),
        ]
        request.httpBody = Data((form.percentEncodedQuery ?? "").utf8)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // 400 invalid_grant: the grant was revoked or the refresh token reused. Sign in again.
        if (400..<500).contains(status) { throw TokenError.signedOut }
        guard status == 200 else { throw URLError(.badServerResponse) }
        struct Answer: Decodable {
            let access_token: String
            let refresh_token: String?
            let expires_in: Double
        }
        let answer = try JSONDecoder().decode(Answer.self, from: data)
        return SyncTokens(
            accessToken: answer.access_token,
            refreshToken: answer.refresh_token ?? refreshToken,
            expiresAt: Date().timeIntervalSince1970 + answer.expires_in
        )
    }

    // MARK: Keychain

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: identity.keychainService,
            kSecAttrAccount as String: "sync",
            kSecAttrAccessGroup as String: identity.keychainGroup,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func read() throws -> SyncTokens? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw TokenError.keychain(status) }
        return try? JSONDecoder().decode(SyncTokens.self, from: data)
    }

    public func write(_ tokens: SyncTokens) throws {
        let data = try JSONEncoder().encode(tokens)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw TokenError.keychain(status) }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw TokenError.keychain(added) }
    }
}

/// An exclusive `flock` on a file, held until `unlock`. Blocks the calling thread while another
/// process holds it, which a refresh does for one request at most.
struct FileLock {
    private let descriptor: Int32

    init(url: URL) throws {
        descriptor = open(url.path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        guard flock(descriptor, LOCK_EX) == 0 else {
            close(descriptor)
            throw POSIXError(.init(rawValue: errno) ?? .EIO)
        }
    }

    func unlock() {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

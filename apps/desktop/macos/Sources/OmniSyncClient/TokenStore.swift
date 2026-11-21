import Foundation
import OmniSyncCore
import Security
@preconcurrency import StorageSync

/// The sync grant: an OAuth access token for `/api/storage/sync` and the refresh token that
/// renews it (client `omni-desktop`), in the shape the app writes to the
/// keychain (`desktopSyncTokensSchema`). Never logged.
public typealias SyncTokens = DesktopSyncTokens

extension DesktopSyncTokens {
    /// Refreshed a minute early.
    var expiresSoon: Bool { expiresAt - 60 <= Date().timeIntervalSince1970 }
}

public enum TokenError: Error, Equatable {
    /// No grant in the keychain, or the server refused the refresh: sign in again in the app.
    case signedOut
    /// The token endpoint could not refresh now (rate limited, failing, or the lock stayed
    /// taken): the grant stays, and the call is tried again later.
    case unavailable(status: Int)
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
/// keychain again once it has it: whoever got there first already wrote a new pair. Inside one
/// process, refreshes queue on `RefreshQueue` first, so only one thread ever waits on the lock,
/// and it waits on a thread of its own, never one of Swift concurrency's few.
public final class TokenStore: AccessTokenSource {
    private let identity: SharedIdentity
    private let settings: @Sendable () -> SyncSettings?
    private let session: URLSession
    /// The pair last read or written, so a call whose token is still good asks the keychain
    /// nothing. A refresh always reads the keychain again, under the lock.
    private let remembered = Remembered<SyncTokens>()

    public init(identity: SharedIdentity, settings: @escaping @Sendable () -> SyncSettings?, session: URLSession = SyncClient.session) {
        self.identity = identity
        self.settings = settings
        self.session = session
    }

    /// An access token to send, refreshed first when it is about to expire.
    public func accessToken() async throws -> String {
        if let tokens = remembered.value, !tokens.expiresSoon { return tokens.accessToken }
        guard let tokens = try read() else { throw TokenError.signedOut }
        if !tokens.expiresSoon { return tokens.accessToken }
        return try await refresh(rejected: tokens.accessToken)
    }

    /// A new access token after the server refused `rejected` with `401`. If another call or
    /// process already replaced it, that one is used and no refresh is sent.
    public func refresh(rejected: String) async throws -> String {
        try await RefreshQueue.shared.run { try await self.refreshLocked(rejected: rejected) }
    }

    private func refreshLocked(rejected: String) async throws -> String {
        guard let lockURL = identity.container?.appendingPathComponent("token.lock") else {
            throw TokenError.signedOut
        }
        let lock = try await FileLock.acquire(lockURL)
        defer { lock.unlock() }
        guard let tokens = try read() else { throw TokenError.signedOut }
        if tokens.accessToken != rejected, !tokens.expiresSoon { return tokens.accessToken }
        // Only a refusal of the grant itself signs out. Anything else (no connection, a timeout,
        // a refresh whose answer never came back, a 429 or a 5xx) keeps the grant here, and the
        // next call tries again.
        do {
            let fresh = try await exchange(tokens.refreshToken)
            try write(fresh)
            return fresh.accessToken
        } catch TokenError.signedOut {
            // The server refused the grant (revoked, expired): it is gone here too, so the app
            // reports `needs_attention` and turning sync on signs in again.
            try? delete()
            throw TokenError.signedOut
        }
    }

    private func exchange(_ refreshToken: String) async throws -> SyncTokens {
        guard let settings = settings() else { throw TokenError.signedOut }
        var request = URLRequest(url: settings.origin.appendingPathComponent("api/auth/oauth2/token"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.httpBody = formBody([
            ("grant_type", "refresh_token"),
            ("refresh_token", refreshToken),
            ("client_id", "omni-desktop"),
            ("resource", settings.api.absoluteString),
        ])
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            switch TokenRefusal(status: status, body: data) {
            case .signedOut: throw TokenError.signedOut
            case .tryLater: throw TokenError.unavailable(status: status)
            }
        }
        return try Self.tokens(from: data, keeping: refreshToken)
    }

    /// The token endpoint's answer as tokens; a refresh that sends no new refresh token keeps
    /// the old one.
    static func tokens(from data: Data, keeping refreshToken: String?) throws -> SyncTokens {
        struct Answer: Decodable {
            let access_token: String
            let refresh_token: String?
            let expires_in: Double
        }
        let answer = try JSONDecoder().decode(Answer.self, from: data)
        guard let refresh = answer.refresh_token ?? refreshToken else { throw TokenError.signedOut }
        return SyncTokens(
            accessToken: answer.access_token,
            expiresAt: Date().timeIntervalSince1970 + answer.expires_in,
            refreshToken: refresh
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
        if status == errSecItemNotFound {
            remembered.value = nil
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else { throw TokenError.keychain(status) }
        let tokens = try? JSONDecoder().decode(SyncTokens.self, from: data)
        remembered.value = tokens
        return tokens
    }

    public func write(_ tokens: SyncTokens) throws {
        let data = try JSONEncoder().encode(tokens)
        remembered.value = nil
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess {
            remembered.value = tokens
            return
        }
        guard status == errSecItemNotFound else { throw TokenError.keychain(status) }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw TokenError.keychain(added) }
        remembered.value = tokens
    }

    /// Signing out: the grant leaves this computer.
    public func delete() throws {
        remembered.value = nil
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TokenError.keychain(status) }
    }
}

/// Runs refreshes one after another inside this process. An actor alone would not do: it lets
/// the next call in while the current one waits on the network.
actor RefreshQueue {
    static let shared = RefreshQueue()
    private var last: Task<Void, Never>?

    func run<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = last
        let next = Task { () async throws -> T in
            await previous?.value
            return try await work()
        }
        last = Task { _ = try? await next.value }
        return try await next.value
    }
}

/// An exclusive `flock` on a file, held until `unlock`, shared with the app's process.
struct FileLock: Sendable {
    private let descriptor: Int32

    /// Most a refresh waits for the other process: one token request, with room to spare.
    static let patience: TimeInterval = 30

    /// Takes the lock on a thread of its own, polling, so a wait never holds one of the
    /// cooperative pool's threads. Gives up after `patience` as `unavailable`.
    static func acquire(_ url: URL) async throws -> FileLock {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                continuation.resume(with: Result { try FileLock(url: url, patience: patience) })
            }
        }
    }

    private init(url: URL, patience: TimeInterval) throws {
        let descriptor = open(url.path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
        let deadline = Date().addingTimeInterval(patience)
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            let failure = errno
            guard failure == EWOULDBLOCK, Date() < deadline else {
                close(descriptor)
                if failure == EWOULDBLOCK { throw TokenError.unavailable(status: 0) }
                throw POSIXError(.init(rawValue: failure) ?? .EIO)
            }
            usleep(50_000)
        }
        self.descriptor = descriptor
    }

    func unlock() {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

/// One value behind a lock.
final class Remembered<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value?

    var value: Value? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}

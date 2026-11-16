import Foundation

/// What the app and the extension share, set when the app is built (the extension's Info.plist
/// carries the same values): the App Group whose container both read, and the keychain access
/// group the sync token lives in. Nothing Handlemotion-specific is compiled in.
public struct SharedIdentity: Sendable {
    public let appGroup: String
    public let keychainGroup: String
    /// The keychain service the token is stored under: `<app bundle id>.sync`.
    public let keychainService: String

    public init(appGroup: String, keychainGroup: String, keychainService: String) {
        self.appGroup = appGroup
        self.keychainGroup = keychainGroup
        self.keychainService = keychainService
    }

    /// Read from a bundle's Info.plist keys `OmniAppGroup`, `OmniKeychainGroup` and
    /// `OmniKeychainService`.
    public init?(bundle: Bundle = .main) {
        guard
            let group = bundle.object(forInfoDictionaryKey: "OmniAppGroup") as? String,
            let keychain = bundle.object(forInfoDictionaryKey: "OmniKeychainGroup") as? String,
            let service = bundle.object(forInfoDictionaryKey: "OmniKeychainService") as? String
        else { return nil }
        self.init(appGroup: group, keychainGroup: keychain, keychainService: service)
    }

    public var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }
}

/// `sync.json` in the App Group container, written by the app (Settings → Drive) and read by
/// the extension: which server, and which workspaces are switched on. Workspace names come from
/// `/sync/drives`, so a rename on the server reaches Finder without the app.
public struct SyncSettings: Codable, Equatable, Sendable {
    /// The Omni server's origin, as the person chose it.
    public var origin: URL
    /// Workspaces with sync on, by org id.
    public var workspaces: [String]
    /// Paused from the tray: the extension answers `.serverUnreachable` until it is cleared.
    public var paused: Bool

    public init(origin: URL, workspaces: [String], paused: Bool = false) {
        self.origin = origin
        self.workspaces = workspaces
        self.paused = paused
    }

    public static let fileName = "sync.json"

    public static func read(from container: URL) -> SyncSettings? {
        let url = container.appendingPathComponent(fileName)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SyncSettings.self, from: data)
    }

    public func write(to container: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        try encoder.encode(self).write(to: container.appendingPathComponent(Self.fileName), options: .atomic)
    }

    /// The sync API every call goes to.
    public var api: URL { origin.appendingPathComponent("api/storage/sync") }
}

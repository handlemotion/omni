import FileProvider
@preconcurrency import StorageSync

/// One synced drive: a workspace's `personal` or `shared` space.
public struct Drive: Hashable, Sendable, Comparable {
    public let orgId: String
    public let space: Space

    public init(orgId: String, space: Space) {
        self.orgId = orgId
        self.space = space
    }

    /// The anchor's key, `<orgId>:<space>`.
    public var key: String { "\(orgId):\(space.rawValue)" }

    public static func < (lhs: Drive, rhs: Drive) -> Bool { lhs.key < rhs.key }
}

/// The working set's sync anchor: each synced drive's `/changes` cursor, as the small JSON map
/// `{ "<orgId>:<space>": <cursor> }`. A drive with no entry has never been listed and starts from
/// the beginning of its feed. Beside each cursor, `"<orgId>:<space>#revision"` is the drive's
/// revision (`/sync/drives`) when its feed was last read to the end: while `/drives` still says
/// that revision, nothing changed there and its feed is not asked.
public struct SyncAnchor: Equatable, Sendable {
    public private(set) var cursors: [String: String]

    public init(cursors: [String: String] = [:]) {
        self.cursors = cursors
    }

    /// Reads an anchor this provider wrote. Anything else (an older format, another provider's
    /// bytes) is expired: the system enumerates the working set again, which converges.
    public init(_ anchor: NSFileProviderSyncAnchor) throws {
        guard let cursors = try? JSONDecoder().decode([String: String].self, from: anchor.rawValue) else {
            throw NSFileProviderError(.syncAnchorExpired)
        }
        self.cursors = cursors
    }

    /// Sorted keys, so the same cursors are the same bytes and the system sees no false change.
    public var anchor: NSFileProviderSyncAnchor {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        // A [String: String] always encodes.
        return NSFileProviderSyncAnchor((try? encoder.encode(cursors)) ?? Data("{}".utf8))
    }

    public func cursor(for drive: Drive) -> String? { cursors[drive.key] }

    public mutating func set(_ cursor: String, for drive: Drive) { cursors[drive.key] = cursor }

    /// The drive's revision when its feed was last read to the end.
    public func revision(for drive: Drive) -> Int? { cursors[Self.revisionKey(drive)].flatMap { Int($0) } }

    public mutating func set(revision: Int, for drive: Drive) { cursors[Self.revisionKey(drive)] = String(revision) }

    /// Whether `drive`, now at `revision`, has nothing new since its feed was last read to the end.
    public func isCurrent(_ drive: Drive, at revision: Int) -> Bool {
        cursor(for: drive) != nil && self.revision(for: drive) == revision
    }

    /// Keeps only the drives synced now: a workspace turned off drops out, one turned on starts
    /// from no cursor.
    public func keeping(_ drives: Set<Drive>) -> SyncAnchor {
        let keys = Set(drives.flatMap { [$0.key, Self.revisionKey($0)] })
        return SyncAnchor(cursors: cursors.filter { keys.contains($0.key) })
    }

    private static func revisionKey(_ drive: Drive) -> String { "\(drive.key)#revision" }
}

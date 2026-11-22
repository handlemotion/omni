import FileProvider
@preconcurrency import StorageSync

/// One synced drive: a workspace's `personal` or `shared` space, or a teamspace the person is in.
public struct Drive: Hashable, Sendable, Comparable {
    public enum Place: Hashable, Sendable {
        case space(Space)
        case teamspace(String)
    }

    public let orgId: String
    public let place: Place

    public init(orgId: String, space: Space) {
        self.orgId = orgId
        place = .space(space)
    }

    public init(orgId: String, teamspaceId: String) {
        self.orgId = orgId
        place = .teamspace(teamspaceId)
    }

    /// Reads a key this provider wrote; nil for anything else.
    public init?(key: String) {
        let parts = key.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        switch parts.count {
        case 2:
            guard !parts[0].isEmpty, let space = Space(rawValue: parts[1]) else { return nil }
            self.init(orgId: parts[0], space: space)
        case 3 where parts[1] == "teamspace":
            guard !parts[0].isEmpty, !parts[2].isEmpty else { return nil }
            self.init(orgId: parts[0], teamspaceId: parts[2])
        default:
            return nil
        }
    }

    /// The anchor's key: `<orgId>:<space>`, or `<orgId>:teamspace:<teamspaceId>`.
    public var key: String {
        switch place {
        case let .space(space): "\(orgId):\(space.rawValue)"
        case let .teamspace(teamspaceId): "\(orgId):teamspace:\(teamspaceId)"
        }
    }

    /// The folder it is in Finder.
    public var item: ItemID {
        switch place {
        case let .space(space): .space(orgId: orgId, space: space)
        case let .teamspace(teamspaceId): .teamspace(orgId: orgId, teamspaceId: teamspaceId)
        }
    }

    /// Every drive the workspace syncs, with its revision now: its spaces, then its teamspaces.
    public static func of(_ workspace: StorageSyncWorkspace) -> [(drive: Drive, revision: Int)] {
        workspace.drives.map { (Drive(orgId: workspace.orgId, space: $0.space), $0.revision) }
            + (workspace.teamspaces ?? []).map { (Drive(orgId: workspace.orgId, teamspaceId: $0.id), $0.revision) }
    }

    public static func < (lhs: Drive, rhs: Drive) -> Bool { lhs.key < rhs.key }
}

/// The working set's sync anchor: each synced drive's `/changes` cursor, as the small JSON map
/// `{ "<orgId>:<space>": <cursor> }` (a teamspace's key is `<orgId>:teamspace:<id>`). A drive with no entry has never been listed and starts from
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

    /// The drives it holds a cursor for.
    public var drives: Set<Drive> { Set(cursors.keys.compactMap { Drive(key: $0) }) }

    /// Keeps only the drives synced now: a workspace turned off drops out, one turned on starts
    /// from no cursor.
    public func keeping(_ drives: Set<Drive>) -> SyncAnchor {
        let keys = Set(drives.flatMap { [$0.key, Self.revisionKey($0)] })
        return SyncAnchor(cursors: cursors.filter { keys.contains($0.key) })
    }

    private static func revisionKey(_ drive: Drive) -> String { "\(drive.key)#revision" }
}

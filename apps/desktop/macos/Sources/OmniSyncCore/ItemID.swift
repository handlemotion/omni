import FileProvider
@preconcurrency import StorageSync

/// What a File Provider item identifier names. One domain holds every synced workspace, so a
/// Storage node's identifier carries its workspace: a node id alone does not say which
/// `/sync/:orgId` to call. The two levels above the nodes are made up by the provider.
public enum ItemID: Hashable, Sendable {
    /// The domain's root: one folder per synced workspace.
    case root
    /// The working set: the only enumerator that reports changes.
    case workingSet
    /// The system's trash. Omni items never go there (delete is Trash on the server).
    case trash
    /// `ws:<orgId>`, a workspace's folder.
    case workspace(orgId: String)
    /// `space:<orgId>:<personal|shared>`, `My files` or `Shared`.
    case space(orgId: String, space: Space)
    /// `teamspace:<orgId>:<teamspaceId>`, a teamspace the person is in, beside `My files`.
    case teamspace(orgId: String, teamspaceId: String)
    /// `<orgId>:<nodeId>`, a Storage file or folder.
    case node(orgId: String, nodeId: String)

    public init?(_ identifier: NSFileProviderItemIdentifier) {
        switch identifier {
        case .rootContainer: self = .root
        case .workingSet: self = .workingSet
        case .trashContainer: self = .trash
        default: self.init(rawValue: identifier.rawValue)
        }
    }

    /// Parses a made-up or node identifier. Anything else, or a part that is empty or holds a
    /// colon, is nil: the extension answers `.noSuchItem` rather than call the wrong workspace.
    init?(rawValue: String) {
        let parts = rawValue.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        switch (parts.first, parts.count) {
        case ("ws", 2):
            guard Self.isPart(parts[1]) else { return nil }
            self = .workspace(orgId: parts[1])
        case ("space", 3):
            guard Self.isPart(parts[1]), let space = Space(rawValue: parts[2]) else { return nil }
            self = .space(orgId: parts[1], space: space)
        case ("teamspace", 3):
            guard Self.isPart(parts[1]), Self.isPart(parts[2]) else { return nil }
            self = .teamspace(orgId: parts[1], teamspaceId: parts[2])
        case (_, 2):
            guard Self.isPart(parts[0]), Self.isPart(parts[1]) else { return nil }
            self = .node(orgId: parts[0], nodeId: parts[1])
        default:
            return nil
        }
    }

    public var identifier: NSFileProviderItemIdentifier {
        switch self {
        case .root: .rootContainer
        case .workingSet: .workingSet
        case .trash: .trashContainer
        case let .workspace(orgId): NSFileProviderItemIdentifier("ws:\(orgId)")
        case let .space(orgId, space): NSFileProviderItemIdentifier("space:\(orgId):\(space.rawValue)")
        case let .teamspace(orgId, teamspaceId): NSFileProviderItemIdentifier("teamspace:\(orgId):\(teamspaceId)")
        case let .node(orgId, nodeId): NSFileProviderItemIdentifier("\(orgId):\(nodeId)")
        }
    }

    /// The workspace this item belongs to; nil for the system's containers.
    public var orgId: String? {
        switch self {
        case .root, .workingSet, .trash: nil
        case let .workspace(orgId), let .space(orgId, _), let .teamspace(orgId, _), let .node(orgId, _): orgId
        }
    }

    /// A node's parent in Finder: its folder, or its drive's folder at the top level (its
    /// teamspace's, or `My files` or `Shared`).
    public static func parent(of node: StorageNode) -> ItemID {
        if let parentId = node.parentId { return .node(orgId: node.orgId, nodeId: parentId) }
        if node.space == .teamspace, let teamspaceId = node.teamspaceId {
            return .teamspace(orgId: node.orgId, teamspaceId: teamspaceId)
        }
        return .space(orgId: node.orgId, space: Space(rawValue: node.space.rawValue) ?? .shared)
    }

    // A workspace id `ws` would make `ws:<id>` ambiguous with a node; Storage ids are UUIDs.
    private static func isPart(_ part: String) -> Bool {
        !part.isEmpty && part != "ws" && part != "space" && part != "teamspace"
    }
}

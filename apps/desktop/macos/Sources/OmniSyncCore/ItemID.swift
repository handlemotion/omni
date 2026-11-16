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
        case let .node(orgId, nodeId): NSFileProviderItemIdentifier("\(orgId):\(nodeId)")
        }
    }

    /// The workspace this item belongs to; nil for the system's containers.
    public var orgId: String? {
        switch self {
        case .root, .workingSet, .trash: nil
        case let .workspace(orgId), let .space(orgId, _), let .node(orgId, _): orgId
        }
    }

    /// A node's parent in Finder: its folder, or its drive's space folder at the top level.
    public static func parent(of node: StorageNode) -> ItemID {
        if let parentId = node.parentId { return .node(orgId: node.orgId, nodeId: parentId) }
        return .space(orgId: node.orgId, space: node.space)
    }

    // A workspace id `ws` would make `ws:<id>` ambiguous with a node; Storage ids are UUIDs.
    private static func isPart(_ part: String) -> Bool { !part.isEmpty && part != "ws" && part != "space" }
}

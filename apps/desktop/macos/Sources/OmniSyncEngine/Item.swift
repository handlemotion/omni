import FileProvider
import OmniSyncCore
@preconcurrency import StorageSync
import UniformTypeIdentifiers

/// One thing in Finder: a made-up level (a workspace's folder, `My files`, `Shared`, a teamspace) or a
/// Storage node. Everything it says comes from the server's answer, never from a guess.
///
/// Every attribute is worked out once, when the item is made: the system reads them many times
/// over, for thousands of items at once. The node itself is not kept.
public final class Item: NSObject, NSFileProviderItem {
    public let id: ItemID
    private let name: String
    private let parent: ItemID
    public let capabilities: NSFileProviderItemCapabilities
    public let itemVersion: NSFileProviderItemVersion
    public let contentType: UTType
    public let documentSize: NSNumber?
    public let creationDate: Date?
    public let contentModificationDate: Date?

    /// A Storage node, where it sits now.
    public init(node: StorageNode) {
        id = .node(orgId: node.orgId, nodeId: node.id)
        name = node.name
        parent = ItemID.parent(of: node)
        capabilities = OmniSyncCore.capabilities(of: id, node: node)
        itemVersion = OmniSyncCore.itemVersion(of: node)
        contentType = node.kind == .file ? Self.types.type(of: node.name, mimeType: node.mimeType) : .folder
        documentSize = NSNumber(value: node.size)
        creationDate = WireDate.parse(node.createdAt)
        contentModificationDate = WireDate.parse(node.updatedAt)
    }

    private init(level id: ItemID, name: String, parent: ItemID) {
        self.id = id
        self.name = name
        self.parent = parent
        capabilities = OmniSyncCore.capabilities(of: id)
        itemVersion = fixedItemVersion
        contentType = .folder
        documentSize = nil
        creationDate = nil
        contentModificationDate = nil
    }

    /// The domain's root: the system asks for it before anything else.
    public convenience init(rootNamed name: String) {
        self.init(level: .root, name: name, parent: .root)
    }

    /// A synced workspace's folder at the root, named after the workspace.
    public convenience init(workspace: StorageSyncWorkspace) {
        self.init(level: .workspace(orgId: workspace.orgId), name: workspace.name, parent: .root)
    }

    /// A teamspace the person is in, inside its workspace's folder, under `name`
    /// (`teamspaceFolderNames`).
    public convenience init(orgId: String, teamspaceId: String, name: String) {
        self.init(level: .teamspace(orgId: orgId, teamspaceId: teamspaceId), name: name, parent: .workspace(orgId: orgId))
    }

    /// The folders inside a workspace's: `My files`, `Shared` in a company, and each teamspace.
    public static func drives(of workspace: StorageSyncWorkspace) -> [Item] {
        let names = teamspaceFolderNames(workspace.teamspaces ?? [])
        return workspace.drives.map { Item(orgId: workspace.orgId, space: $0.space) }
            + (workspace.teamspaces ?? []).map {
                Item(orgId: workspace.orgId, teamspaceId: $0.id, name: names[$0.id] ?? $0.name)
            }
    }

    /// `My files` or `Shared` inside a workspace's folder.
    public convenience init(orgId: String, space: Space) {
        self.init(level: .space(orgId: orgId, space: space), name: space == .personal ? "My files" : "Shared", parent: .workspace(orgId: orgId))
    }

    public var itemIdentifier: NSFileProviderItemIdentifier { id.identifier }
    public var parentItemIdentifier: NSFileProviderItemIdentifier { parent.identifier }
    public var filename: String { name }

    private static let types = Types()
}

/// A file's type by its extension, else its MIME type. Each lookup asks Launch Services, so the
/// answer is kept per extension and MIME type: a folder of thousands of PDFs asks once.
private final class Types: @unchecked Sendable {
    private let lock = NSLock()
    private var known: [String: UTType] = [:]

    func type(of name: String, mimeType: String?) -> UTType {
        let ext = (name as NSString).pathExtension
        let key = "\(ext)\n\(mimeType ?? "")"
        if let type = lock.withLock({ known[key] }) { return type }
        let type = UTType(filenameExtension: ext) ?? mimeType.flatMap { UTType(mimeType: $0) } ?? .data
        lock.withLock { known[key] = type }
        return type
    }
}

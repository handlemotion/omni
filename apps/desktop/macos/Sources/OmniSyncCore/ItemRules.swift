import FileProvider
@preconcurrency import StorageSync

/// The File Provider version of a node: `contentVersion` is its `content_version`,
/// `metadataVersion` its `revision`, each as a decimal string's bytes. A folder's content never
/// changes version: only its children do, and they carry their own.
public func itemVersion(of node: StorageNode) -> NSFileProviderItemVersion {
    let content = node.kind == .folder ? 0 : (node.contentVersion ?? 0)
    return NSFileProviderItemVersion(
        contentVersion: Data(String(content).utf8),
        metadataVersion: Data(String(node.revision ?? 0).utf8)
    )
}

/// The one version the made-up levels ever have.
public var fixedItemVersion: NSFileProviderItemVersion {
    NSFileProviderItemVersion(contentVersion: Data("0".utf8), metadataVersion: Data("0".utf8))
}

/// The content version a modify read, for `ifContentVersion`. Nil when the version is not one
/// this provider wrote, so the upload is refused rather than sent unguarded.
public func contentVersion(of version: NSFileProviderItemVersion) -> Int? {
    String(data: version.contentVersion, encoding: .utf8).flatMap { Int($0) }
}

/// What Finder lets the person do. The made-up levels can be read and listed, and a space folder
/// takes new children; a locked file is read only. Delete means Trash on the server. Any node's
/// download can be removed ("Remove Download") and the node kept off this computer.
public func capabilities(of item: ItemID, node: StorageNode? = nil) -> NSFileProviderItemCapabilities {
    let browse: NSFileProviderItemCapabilities = [.allowsReading, .allowsContentEnumerating]
    switch item {
    case .root, .workingSet, .trash, .workspace:
        return browse
    case .space:
        return browse.union(.allowsAddingSubItems)
    case .node:
        let local: NSFileProviderItemCapabilities = [.allowsExcludingFromSync]
        if node?.lockedAt != nil { return local.union(.allowsReading) }
        if node?.kind == .folder {
            return browse.union(local).union([.allowsAddingSubItems, .allowsRenaming, .allowsReparenting, .allowsDeleting])
        }
        return local.union([.allowsReading, .allowsWriting, .allowsRenaming, .allowsReparenting, .allowsDeleting])
    }
}

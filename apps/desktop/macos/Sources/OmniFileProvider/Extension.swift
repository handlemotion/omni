import FileProvider
import OmniSyncClient
import OmniSyncCore
import OmniSyncEngine
@preconcurrency import StorageSync
import SystemConfiguration
import UniformTypeIdentifiers

/// The Omni File Provider: one domain, a folder per synced workspace. It
/// answers the system's four questions (what is here, what changed, give me the bytes, here is a
/// change) from the Storage sync API and decides nothing the server decides.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    private let domain: NSFileProviderDomain

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        super.init()
    }

    func invalidate() {}

    // MARK: Reading

    func item(
        for identifier: NSFileProviderItemIdentifier,
        request _: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        task {
            do {
                completionHandler(try await Self.item(identifier), nil)
            } catch {
                completionHandler(nil, systemError(error))
            }
        }
    }

    func fetchContents(
        for identifier: NSFileProviderItemIdentifier,
        version _: NSFileProviderItemVersion?,
        request _: NSFileProviderRequest,
        completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 100)
        let domain = domain
        return task(progress) {
            do {
                guard case let .node(orgId, nodeId)? = ItemID(identifier) else { throw NSFileProviderError(.noSuchItem) }
                let sync = try Sync.load()
                // The item must be the version that was served. The download's ETag is the
                // stored object's, not the content version, so the node is read on both sides
                // of the download: if it changed in between, the system asks again.
                let before = try await sync.client.node(orgId: orgId, id: nodeId)
                let (downloaded, _) = try await sync.client.download(orgId: orgId, id: nodeId, progress: progress)
                // Whatever fails or is cancelled from here on, the bytes are not left behind.
                var file = downloaded
                do {
                    file = try Self.keep(downloaded, domain: domain)
                    let node = try await sync.client.node(orgId: orgId, id: nodeId)
                    if node.contentVersion != before.contentVersion { throw NSFileProviderError(.serverUnreachable) }
                    try Task.checkCancellation()
                    completionHandler(file, Item(node: node), nil)
                } catch {
                    try? FileManager.default.removeItem(at: file)
                    throw error
                }
            } catch {
                completionHandler(nil, nil, systemError(error))
            }
        }
    }

    func enumerator(for container: NSFileProviderItemIdentifier, request _: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        guard let id = ItemID(container) else { throw NSFileProviderError(.noSuchItem) }
        switch id {
        case .workingSet:
            let domain = domain
            return WorkingSetEnumerator(signalLater: { delay in
                DispatchQueue.global().asyncAfter(deadline: .now() + delay) {
                    NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
                }
            })
        case .trash: throw NSFileProviderError(.noSuchItem)
        default: return FolderEnumerator(container: id)
        }
    }

    // MARK: Changes from the computer

    func createItem(
        basedOn template: NSFileProviderItem,
        fields _: NSFileProviderItemFields,
        contents url: URL?,
        options: NSFileProviderCreateItemOptions = [],
        request _: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        return task(progress) {
            do {
                let node = try await Self.create(template, contents: url, mayExist: options.contains(.mayAlreadyExist), progress: progress)
                completionHandler(Item(node: node), [], false, nil)
            } catch {
                completionHandler(nil, [], false, systemError(error))
            }
        }
    }

    func modifyItem(
        _ item: NSFileProviderItem,
        baseVersion: NSFileProviderItemVersion,
        changedFields: NSFileProviderItemFields,
        contents newContents: URL?,
        options _: NSFileProviderModifyItemOptions = [],
        request _: NSFileProviderRequest,
        completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
    ) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        let domain = domain
        return task(progress) {
            do {
                let (node, conflicted) = try await Self.modify(item, base: baseVersion, fields: changedFields, contents: newContents, progress: progress)
                // After a conflict the item is the server's version: the system fetches its
                // bytes, and the conflicted copy arrives with the next change of the working set.
                completionHandler(Item(node: node), [], conflicted, nil)
                if conflicted { NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in } }
            } catch {
                completionHandler(nil, [], false, systemError(error))
            }
        }
    }

    func deleteItem(
        identifier: NSFileProviderItemIdentifier,
        baseVersion: NSFileProviderItemVersion,
        options _: NSFileProviderDeleteItemOptions = [],
        request _: NSFileProviderRequest,
        completionHandler: @escaping (Error?) -> Void
    ) -> Progress {
        task {
            do {
                guard case let .node(orgId, nodeId)? = ItemID(identifier) else { throw NSFileProviderError(.deletionRejected) }
                // Trash, never gone for good: restorable in the app for 30 days.
                try await Sync.load().client.trash(orgId: orgId, id: nodeId, ifRevision: Self.revision(of: baseVersion))
                completionHandler(nil)
            } catch let error as SyncHTTPError where error.failure == .versionConflict || error.code == "locked" {
                // Changed or locked on the server since: the system brings the item back.
                completionHandler(NSFileProviderError(.deletionRejected))
            } catch let error as SyncHTTPError where error.status == 404 {
                completionHandler(nil) // Already gone.
            } catch {
                completionHandler(systemError(error))
            }
        }
    }

    // MARK: Work

    private static func item(_ identifier: NSFileProviderItemIdentifier) async throws -> Item {
        guard let id = ItemID(identifier) else { throw NSFileProviderError(.noSuchItem) }
        if id == .root { return Item(rootNamed: "Omni") }
        let sync = try Sync.load()
        switch id {
        case .root, .workingSet, .trash:
            throw NSFileProviderError(.noSuchItem)
        case let .workspace(orgId):
            guard let ws = try await sync.workspaces().first(where: { $0.orgId == orgId }) else { throw NSFileProviderError(.noSuchItem) }
            return Item(workspace: ws)
        case let .space(orgId, space):
            guard let ws = try await sync.workspaces().first(where: { $0.orgId == orgId }),
                  ws.drives.contains(where: { $0.space == space })
            else { throw NSFileProviderError(.noSuchItem) }
            return Item(orgId: orgId, space: space)
        case let .node(orgId, nodeId):
            return Item(node: try await sync.client.node(orgId: orgId, id: nodeId))
        }
    }

    private static func create(_ template: NSFileProviderItem, contents: URL?, mayExist: Bool, progress: Progress) async throws -> StorageNode {
        guard let parent = ItemID(template.parentItemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
        let name = template.filename
        if isIgnored(name) || template.contentType == .symbolicLink { throw NSFileProviderError(.excludedFromSync) }
        let sync = try Sync.load()
        let place = try Sync.place(of: parent)
        if mayExist, let existing = try await FolderIndex.shared.node(named: name, in: place, sync: sync),
           (existing.kind == .folder) == (template.contentType == .folder) {
            return existing
        }
        if template.contentType == .folder {
            let body = StorageCreateFolderBody(name: name, parentId: place.parentId, space: place.space, teamspaceId: nil)
            return try await sync.client.createFolder(orgId: place.orgId, body)
        }
        guard let contents else { throw NSFileProviderError(.cannotSynchronize) }
        let mime = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType
        let uploader = Uploader(sync: sync, orgId: place.orgId, key: template.itemIdentifier.rawValue)
        return try await uploader.send(try await Uploader.measure(contents), open: { size, sha256 in
            let body = StorageOpenUploadBody(mimeType: mime, name: name, parentId: place.parentId, sha256: sha256, size: size, space: place.space, teamspaceId: nil)
            return try await sync.client.openUpload(orgId: place.orgId, body)
        }, progress: progress)
    }

    /// Applies a change from Finder: a move, a rename, new bytes. Answers the node as the server
    /// has it now, and whether that is the server's version after a conflict.
    private static func modify(
        _ item: NSFileProviderItem,
        base: NSFileProviderItemVersion,
        fields: NSFileProviderItemFields,
        contents: URL?,
        progress: Progress
    ) async throws -> (StorageNode, conflicted: Bool) {
        guard case let .node(orgId, nodeId)? = ItemID(item.itemIdentifier) else { throw NSFileProviderError(.cannotSynchronize) }
        let sync = try Sync.load()
        var node = try await sync.client.node(orgId: orgId, id: nodeId)
        var revision = revision(of: base)
        if fields.contains(.parentItemIdentifier) {
            guard let parent = ItemID(item.parentItemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
            let place = try Sync.place(of: parent)
            // A move between workspaces is refused, as in the app; Finder offers a copy instead.
            guard place.orgId == orgId else { throw NSFileProviderError(.cannotSynchronize) }
            node = try await sync.client.change(orgId: orgId, id: nodeId, StorageChangeNodeBody(name: nil, icon: nil, parentId: place.parentId, space: place.space, teamspaceId: nil), ifRevision: revision)
            revision = node.revision
        }
        if fields.contains(.filename), item.filename != node.name {
            node = try await sync.client.change(orgId: orgId, id: nodeId, StorageChangeNodeBody(name: item.filename, icon: nil, parentId: nil, space: nil, teamspaceId: nil), ifRevision: revision)
        }
        // The system reports new contents for a move or a download too; only bytes that differ
        // from the server's are an edit.
        if fields.contains(.contents), let contents, node.kind == .file {
            let bytes = try await Uploader.measure(contents)
            if bytes.sha256 != node.contentSha256 {
                return try await save(bytes, over: node, base: base, key: item.itemIdentifier.rawValue, sync: sync, progress: progress)
            }
        }
        // Tags, ranks, last used dates and extended attributes stay on this computer.
        return (node, false)
    }

    /// Saves an edit as a new version of the file, in place: same id, name and sharing. The
    /// server is the judge (spec "Conflicts"): if someone saved since the version this edit was
    /// based on, the edit is kept as `name (conflicted copy, <computer> <date>).ext` beside it,
    /// and the item becomes the server's version. Nothing is overwritten or lost.
    private static func save(
        _ bytes: Uploader.Bytes,
        over node: StorageNode,
        base: NSFileProviderItemVersion,
        key: String,
        sync: Sync,
        progress: Progress
    ) async throws -> (StorageNode, conflicted: Bool) {
        // A version this provider did not write is no guard: refuse rather than save unguarded.
        guard let based = contentVersion(of: base) else { throw NSFileProviderError(.cannotSynchronize) }
        let orgId = node.orgId
        do {
            let saved = try await Uploader(sync: sync, orgId: orgId, key: key).send(
                bytes, replaces: node.id, ifContentVersion: based,
                open: { size, sha256 in
                    let body = StorageOpenVersionBody(ifContentVersion: based, mimeType: node.mimeType, sha256: sha256, size: size)
                    return try await sync.client.openVersion(orgId: orgId, fileId: node.id, body)
                },
                progress: progress
            )
            return (saved, false)
        } catch let error as SyncHTTPError where error.failure == .versionConflict {
            // The server numbers a name already taken, so the copy always lands.
            let name = conflictedCopyName(of: node.name, computer: computerName(), date: Date())
            _ = try await Uploader(sync: sync, orgId: orgId, key: key + "#conflicted").send(
                bytes,
                open: { size, sha256 in
                    let body = StorageOpenUploadBody(
                        mimeType: node.mimeType, name: name, parentId: node.parentId, sha256: sha256, size: size,
                        space: node.parentId == nil ? Space(rawValue: node.space.rawValue) : nil,
                        teamspaceId: nil
                    )
                    return try await sync.client.openUpload(orgId: orgId, body)
                },
                progress: progress
            )
            return (try await sync.client.node(orgId: orgId, id: node.id), true)
        }
    }

    /// The computer's name as the person set it in System Settings, for conflicted copies.
    private static func computerName() -> String {
        if let name = SCDynamicStoreCopyComputerName(nil, nil) as String?, !name.isEmpty { return name }
        return "Mac"
    }

    private static func revision(of version: NSFileProviderItemVersion) -> Int? {
        String(data: version.metadataVersion, encoding: .utf8).flatMap { Int($0) }
    }

    /// Moves a finished download where the system can take it from.
    private static func keep(_ file: URL, domain: NSFileProviderDomain) throws -> URL {
        guard let manager = NSFileProviderManager(for: domain) else { throw NSFileProviderError(.providerNotFound) }
        let destination = try manager.temporaryDirectoryURL().appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: file, to: destination)
        return destination
    }
}

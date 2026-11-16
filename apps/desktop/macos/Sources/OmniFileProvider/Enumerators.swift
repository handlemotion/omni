import FileProvider
import OmniSyncClient
import OmniSyncCore
@preconcurrency import StorageSync

/// Lists one container: the root (a folder per synced workspace), a workspace (its spaces), a
/// space or a folder (`GET /nodes`, paged to the end). Changes are the working set's job.
final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: ItemID

    init(container: ItemID) { self.container = container }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        let container = container
        let cursor = Self.cursor(page)
        Task {
            do {
                let sync = try Sync.load()
                let (items, next) = try await Self.list(container, cursor: cursor, sync: sync)
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: next.map { NSFileProviderPage(Data($0.utf8)) })
            } catch {
                observer.finishEnumeratingWithError(systemError(error))
            }
        }
    }

    // A folder reports no changes of its own: the working set reports every one.
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        completionHandler(NSFileProviderSyncAnchor(Data()))
    }

    private static func cursor(_ page: NSFileProviderPage) -> String? {
        let raw = page.rawValue
        if raw == (NSFileProviderPage.initialPageSortedByName as NSFileProviderPage).rawValue
            || raw == (NSFileProviderPage.initialPageSortedByDate as NSFileProviderPage).rawValue {
            return nil
        }
        return String(data: raw, encoding: .utf8)
    }

    private static func list(_ container: ItemID, cursor: String?, sync: Sync) async throws -> ([Item], String?) {
        switch container {
        case .root:
            return (try await sync.workspaces().map(Item.init(workspace:)), nil)
        case let .workspace(orgId):
            guard let workspace = try await sync.workspaces().first(where: { $0.orgId == orgId }) else {
                throw NSFileProviderError(.noSuchItem)
            }
            return (workspace.drives.map { Item(orgId: orgId, space: $0.space) }, nil)
        case let .space(orgId, space):
            let page = try await sync.client.list(orgId: orgId, space: space, parentId: nil, cursor: cursor)
            return (page.nodes.map(Item.init(node:)), page.nextCursor)
        case let .node(orgId, nodeId):
            let page = try await sync.client.list(orgId: orgId, space: .personal, parentId: nodeId, cursor: cursor)
            return (page.nodes.map(Item.init(node:)), page.nextCursor)
        case .workingSet, .trash:
            throw NSFileProviderError(.noSuchItem)
        }
    }
}

/// The working set: every synced item, and the only enumerator that reports changes. Its anchor
/// is each drive's `/changes` cursor (`SyncAnchor`); a drive with none is read from the start,
/// so the first sync and a workspace switched on are the same path.
final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    /// Pages read per call before handing back with `moreComing`, so one call stays short.
    private static let pagesPerCall = 8

    func invalidate() {}

    /// The made-up levels; the nodes arrive as changes from an empty anchor.
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt _: NSFileProviderPage) {
        Task {
            do {
                observer.didEnumerate(Self.levels(try await Sync.load().workspaces()))
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(systemError(error))
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        // Nothing read yet: the first `enumerateChanges` walks every drive from its start.
        completionHandler(SyncAnchor().anchor)
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from syncAnchor: NSFileProviderSyncAnchor) {
        Task {
            do {
                let sync = try Sync.load()
                let (anchor, more) = try await Self.changes(from: SyncAnchor(syncAnchor), sync: sync, observer: observer)
                observer.finishEnumeratingChanges(upTo: anchor.anchor, moreComing: more)
            } catch let error as SyncHTTPError where error.status == 410 {
                observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
            } catch {
                observer.finishEnumeratingWithError(systemError(error))
            }
        }
    }

    private static func levels(_ workspaces: [StorageSyncWorkspace]) -> [Item] {
        workspaces.flatMap { workspace in
            [Item(workspace: workspace)] + workspace.drives.map { Item(orgId: workspace.orgId, space: $0.space) }
        }
    }

    private static func changes(
        from old: SyncAnchor,
        sync: Sync,
        observer: NSFileProviderChangeObserver
    ) async throws -> (SyncAnchor, Bool) {
        let workspaces = try await sync.workspaces()
        let drives = workspaces.flatMap { ws in ws.drives.map { Drive(orgId: ws.orgId, space: $0.space) } }
        var anchor = old.keeping(Set(drives))

        // A workspace switched off or left: its folder goes, and with it everything inside.
        let kept = Set(workspaces.map(\.orgId))
        let gone = Set(old.cursors.keys.compactMap { $0.split(separator: ":").first.map(String.init) })
            .subtracting(kept)
        if !gone.isEmpty { observer.didDeleteItems(withIdentifiers: gone.map { ItemID.workspace(orgId: $0).identifier }) }
        // The made-up levels, in case a workspace was renamed or switched on.
        observer.didUpdate(levels(workspaces))

        var pages = 0
        for drive in drives.sorted() {
            var more = true
            while more {
                if pages == pagesPerCall { return (anchor, true) }
                let page = try await sync.client.changes(drive, cursor: anchor.cursor(for: drive))
                try await report(ChangeBatch(orgId: drive.orgId, changes: page.changes), sync: sync, observer: observer)
                anchor.set(page.nextCursor, for: drive)
                more = page.more
                pages += 1
            }
        }
        return (anchor, false)
    }

    /// Updates and deletions; a lone tombstone is looked up first, since a node moved between
    /// spaces is a tombstone in one feed and still exists (`ChangeBatch`).
    private static func report(_ batch: ChangeBatch, sync: Sync, observer: NSFileProviderChangeObserver) async throws {
        var updated = batch.updated.map(Item.init(node:))
        var deleted = batch.deleted
        for item in batch.unresolved {
            guard case let .node(orgId, nodeId) = item else { continue }
            do {
                updated.append(Item(node: try await sync.client.node(orgId: orgId, id: nodeId)))
            } catch let error as SyncHTTPError where error.status == 404 {
                deleted.append(item)
            }
        }
        if !updated.isEmpty { observer.didUpdate(updated) }
        if !deleted.isEmpty { observer.didDeleteItems(withIdentifiers: deleted.map(\.identifier)) }
    }
}

import FileProvider
import OmniSyncClient
import OmniSyncCore
@preconcurrency import StorageSync

/// Lists one container: the root (a folder per synced workspace), a workspace (its spaces), a
/// space or a folder (`GET /nodes`, paged to the end). Changes are the working set's job.
public final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: ItemID
    private let load: () throws -> Sync

    public init(container: ItemID, load: @escaping () throws -> Sync = Sync.load) {
        self.container = container
        self.load = load
    }

    public func invalidate() {}

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        let container = container
        let cursor = Self.cursor(page)
        let load = load
        Task {
            do {
                let sync = try load()
                let (items, next) = try await Self.list(container, cursor: cursor, sync: sync)
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: next.map { NSFileProviderPage(Data($0.utf8)) })
            } catch {
                observer.finishEnumeratingWithError(systemError(error))
            }
        }
    }

    // A folder reports no changes of its own: the working set reports every one.
    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
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
            let page = try await sync.client.list(orgId: orgId, space: space, parentId: nil, cursor: cursor, limit: pageSize)
            return (page.nodes.map(Item.init(node:)), page.nextCursor)
        case let .node(orgId, nodeId):
            let page = try await sync.client.list(orgId: orgId, space: .personal, parentId: nodeId, cursor: cursor, limit: pageSize)
            return (page.nodes.map(Item.init(node:)), page.nextCursor)
        case .workingSet, .trash:
            throw NSFileProviderError(.noSuchItem)
        }
    }
}

/// The working set: every synced item, and the only enumerator that reports changes. Its anchor
/// is each drive's `/changes` cursor (`SyncAnchor`); a drive with none is read from the start,
/// so the first sync and a workspace switched on are the same path.
public final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    /// Pages read per call before handing back with `moreComing`, so one call stays short
    /// (2,000 changes at most).
    private static let pagesPerCall = 10
    private let load: () throws -> Sync

    public init(load: @escaping () throws -> Sync = Sync.load) { self.load = load }

    public func invalidate() {}

    /// The made-up levels; the nodes arrive as changes from an empty anchor.
    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt _: NSFileProviderPage) {
        let load = load
        Task {
            do {
                observer.didEnumerate(Self.levels(try await load().workspaces()))
                observer.finishEnumerating(upTo: nil)
            } catch {
                observer.finishEnumeratingWithError(systemError(error))
            }
        }
    }

    public func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        // Nothing read yet: the first `enumerateChanges` walks every drive from its start.
        completionHandler(SyncAnchor().anchor)
    }

    public func enumerateChanges(for observer: NSFileProviderChangeObserver, from syncAnchor: NSFileProviderSyncAnchor) {
        let load = load
        Task {
            do {
                let sync = try load()
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
        let workspaces = try await sync.workspaces(fresh: true)
        let drives = workspaces.flatMap { ws in ws.drives.map { Drive(orgId: ws.orgId, space: $0.space) } }
        var anchor = old.keeping(Set(drives))

        // A workspace switched off or left: its folder goes, and with it everything inside.
        let kept = Set(workspaces.map(\.orgId))
        let gone = Set(old.cursors.keys.compactMap { $0.split(separator: ":").first.map(String.init) })
            .subtracting(kept)
        if !gone.isEmpty { observer.didDeleteItems(withIdentifiers: gone.map { ItemID.workspace(orgId: $0).identifier }) }
        // The made-up levels, in case a workspace was renamed or switched on.
        observer.didUpdate(levels(workspaces))

        // The next page is asked for while this one is reported, so the round trip overlaps
        // the work instead of following it.
        let client = sync.client
        var pages = 0
        for drive in drives.sorted() {
            if pages == pagesPerCall { return (anchor, true) }
            var next: Task<StorageSyncChangesResponse, Error>? = Task { [cursor = anchor.cursor(for: drive)] in
                try await client.changes(drive, cursor: cursor, limit: pageSize)
            }
            defer { next?.cancel() }
            while let fetching = next {
                let page = try await fetching.value
                pages += 1
                next = page.more && pages < pagesPerCall
                    ? Task { [cursor = page.nextCursor] in try await client.changes(drive, cursor: cursor, limit: pageSize) }
                    : nil
                try await report(ChangeBatch(orgId: drive.orgId, changes: page.changes), sync: sync, observer: observer)
                anchor.set(page.nextCursor, for: drive)
                if page.more, next == nil { return (anchor, true) }
            }
        }
        return (anchor, false)
    }

    /// Updates and deletions; a lone tombstone is looked up first, since a node moved between
    /// spaces is a tombstone in one feed and still exists (`ChangeBatch`).
    /// The lookups run eight at a time: a folder moved between spaces is one tombstone per node
    /// inside it.
    private static func report(_ batch: ChangeBatch, sync: Sync, observer: NSFileProviderChangeObserver) async throws {
        var updated = batch.updated.map(Item.init(node:))
        var deleted = batch.deleted
        let client = sync.client
        try await withThrowingTaskGroup(of: (ItemID, StorageNode?).self) { group in
            var pending = batch.unresolved.makeIterator()
            func add() {
                guard let item = pending.next() else { return }
                guard case let .node(orgId, nodeId) = item else { return add() }
                group.addTask {
                    do {
                        return (item, try await client.node(orgId: orgId, id: nodeId))
                    } catch let error as SyncHTTPError where error.status == 404 {
                        return (item, nil)
                    }
                }
            }
            for _ in 0..<8 { add() }
            while let result = try await group.next() {
                let (item, node) = result
                if let node { updated.append(Item(node: node)) } else { deleted.append(item) }
                add()
            }
        }
        if !updated.isEmpty { observer.didUpdate(updated) }
        if !deleted.isEmpty { observer.didDeleteItems(withIdentifiers: deleted.map(\.identifier)) }
    }
}

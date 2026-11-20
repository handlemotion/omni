import FileProvider
import OmniSyncClient
import OmniSyncCore
@preconcurrency import StorageSync

/// Lists one container: the root (a folder per synced workspace), a workspace (its spaces), a
/// space or a folder (`GET /nodes`, paged to the end). Changes are the working set's job.
public final class FolderEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: ItemID
    private let load: () throws -> Sync
    private let running = Running()

    public init(container: ItemID, load: @escaping () throws -> Sync = Sync.load) {
        self.container = container
        self.load = load
    }

    /// The system is done with this enumerator: a listing still in flight stops.
    public func invalidate() { running.cancelAll() }

    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        let container = container
        let cursor = Self.cursor(page)
        let load = load
        running.start {
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
        isInitial(page) ? nil : String(data: page.rawValue, encoding: .utf8)
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

/// Whether `page` is one of the system's first pages rather than one this provider handed back.
func isInitial(_ page: NSFileProviderPage) -> Bool {
    let raw = page.rawValue
    return raw == (NSFileProviderPage.initialPageSortedByName as NSFileProviderPage).rawValue
        || raw == (NSFileProviderPage.initialPageSortedByDate as NSFileProviderPage).rawValue
}

/// The tasks an enumerator has running, so `invalidate()` can stop them.
final class Running: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var cancelled = false

    func start(_ work: @escaping @Sendable () async -> Void) {
        let id = UUID()
        lock.withLock {
            let task = Task { [weak self] in
                await work()
                self?.finish(id)
            }
            if cancelled { task.cancel() } else { tasks[id] = task }
        }
    }

    func cancelAll() {
        let running = lock.withLock {
            cancelled = true
            defer { tasks = [:] }
            return Array(tasks.values)
        }
        for task in running { task.cancel() }
    }

    private func finish(_ id: UUID) { lock.withLock { tasks[id] = nil } }
}

/// The working set: every synced item, and the only enumerator that reports changes. Its anchor
/// is each drive's `/changes` cursor (`SyncAnchor`); a drive with none is read from the start,
/// so the first sync and a workspace switched on are the same path.
public final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    /// Pages read per call before handing back with `moreComing`, so one call stays short
    /// (2,000 changes at most).
    private static let pagesPerCall = 10
    /// How long to wait before asking again after a rate limit cut a read short.
    private static let retryAfterLimit: TimeInterval = 30
    private let load: () throws -> Sync
    private let signalLater: (TimeInterval) -> Void
    private let running = Running()

    /// `signalLater` asks the system to enumerate changes again after a delay: the extension
    /// signals the working set, so a read a rate limit cut short goes on even with no change to
    /// push it.
    public init(
        load: @escaping () throws -> Sync = Sync.load,
        signalLater: @escaping (TimeInterval) -> Void = { _ in }
    ) {
        self.load = load
        self.signalLater = signalLater
    }

    /// The system is done with this enumerator: a read still in flight stops.
    public func invalidate() { running.cancelAll() }

    /// Every synced item: the made-up levels first, then each drive's live nodes, a page of its
    /// feed at a time from no cursor. The system reads this after an expired anchor (`410`) and
    /// removes whatever it does not list, so it lists everything: an item left out would be
    /// evicted and downloaded again.
    public func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        let load = load
        let from = isInitial(page) ? nil : ListingPage(page)
        running.start {
            do {
                let sync = try load()
                let workspaces = try await sync.workspaces(fresh: from == nil)
                let drives = workspaces.flatMap { ws in ws.drives.map { Drive(orgId: ws.orgId, space: $0.space) } }.sorted()
                if from == nil { observer.didEnumerate(Self.levels(workspaces)) }
                // A drive switched off since the last page is skipped, not the ones after it.
                let at = from ?? ListingPage(drive: "", cursor: nil)
                guard let index = drives.firstIndex(where: { $0.key >= at.drive }) else {
                    return observer.finishEnumerating(upTo: nil)
                }
                let drive = drives[index]
                let cursor = drive.key == at.drive ? at.cursor : nil
                let listed = try await sync.client.changes(drive, cursor: cursor, limit: pageSize)
                observer.didEnumerate(listed.changes.compactMap { change in
                    change.inTrash ? nil : change.node.map(Item.init(node:))
                })
                let next = listed.more
                    ? ListingPage(drive: drive.key, cursor: listed.nextCursor)
                    : drives.dropFirst(index + 1).first.map { ListingPage(drive: $0.key, cursor: nil) }
                observer.finishEnumerating(upTo: next?.page)
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
        let signalLater = signalLater
        running.start {
            do {
                let sync = try load()
                let (anchor, more, limited) = try await Self.changes(from: SyncAnchor(syncAnchor), sync: sync, observer: observer)
                observer.finishEnumeratingChanges(upTo: anchor.anchor, moreComing: more)
                if limited { signalLater(Self.retryAfterLimit) }
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
    ) async throws -> (SyncAnchor, Bool, Bool) {
        let workspaces = try await sync.workspaces(fresh: true)
        let drives = workspaces.flatMap { ws in ws.drives.map { (Drive(orgId: ws.orgId, space: $0.space), $0.revision) } }
        var anchor = old.keeping(Set(drives.map(\.0)))

        // A workspace switched off or left: its folder goes, and with it everything inside.
        let kept = Set(workspaces.map(\.orgId))
        let gone = Set(old.cursors.keys.compactMap { $0.split(separator: ":").first.map(String.init) })
            .subtracting(kept)
        if !gone.isEmpty { observer.didDeleteItems(withIdentifiers: gone.map { ItemID.workspace(orgId: $0).identifier }) }
        // The made-up levels, in case a workspace was renamed or switched on.
        observer.didUpdate(levels(workspaces))

        // The next page is asked for while this one is reported, so the round trip overlaps
        // the work instead of following it. A drive whose revision has not moved since its feed
        // was last read to the end is not asked at all.
        let client = sync.client
        var pages = 0
        for (drive, revision) in drives.sorted(by: { $0.0 < $1.0 }) where !anchor.isCurrent(drive, at: revision) {
            if pages == pagesPerCall { return (anchor, true, false) }
            var next: Task<StorageSyncChangesResponse, Error>? = Task { [cursor = anchor.cursor(for: drive)] in
                try await client.changes(drive, cursor: cursor, limit: pageSize)
            }
            defer { next?.cancel() }
            while let fetching = next {
                let page: StorageSyncChangesResponse
                do {
                    page = try await fetching.value
                } catch let error as SyncHTTPError where error.status == 429 && pages > 0 {
                    // Rate limited partway: keep what was read and go on from here after a wait.
                    return (anchor, false, true)
                }
                pages += 1
                next = page.more && pages < pagesPerCall
                    ? Task { [cursor = page.nextCursor] in try await client.changes(drive, cursor: cursor, limit: pageSize) }
                    : nil
                try await report(ChangeBatch(orgId: drive.orgId, changes: page.changes), sync: sync, observer: observer)
                anchor.set(page.nextCursor, for: drive)
                if !page.more { anchor.set(revision: revision, for: drive) }
                if page.more, next == nil { return (anchor, true, false) }
            }
        }
        return (anchor, false, false)
    }
    /// Updates and deletions; a lone tombstone from an older server is looked up first, since a
    /// node moved between spaces is a tombstone in one feed and still exists (`ChangeBatch`).
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

/// Where `enumerateItems` of the working set is: a drive, and its feed's cursor within it.
struct ListingPage: Codable, Equatable {
    let drive: String
    let cursor: String?

    init(drive: String, cursor: String?) {
        self.drive = drive
        self.cursor = cursor
    }

    init?(_ page: NSFileProviderPage) {
        guard let read = try? JSONDecoder().decode(ListingPage.self, from: page.rawValue) else { return nil }
        self = read
    }

    var page: NSFileProviderPage { NSFileProviderPage((try? JSONEncoder().encode(self)) ?? Data()) }
}

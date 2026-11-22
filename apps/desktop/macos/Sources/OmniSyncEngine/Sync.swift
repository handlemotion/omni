import FileProvider
import OmniSyncClient
import OmniSyncCore
@preconcurrency import StorageSync

/// What every call of the extension needs: the shared identity and settings, and a client for
/// the server they name. Kept for the life of the process and built again only when `sync.json`
/// changes (a workspace switched on, a pause), so a call costs no file read, no keychain read and
/// no new client; a change is still seen by the very next call.
public struct Sync {
    public let identity: SharedIdentity
    public let settings: SyncSettings
    public let client: SyncClient
    private let drives = DrivesCache()

    public init(identity: SharedIdentity, settings: SyncSettings, client: SyncClient) {
        self.identity = identity
        self.settings = settings
        self.client = client
    }

    public static func load() throws -> Sync {
        guard let identity = Loaded.identity, let container = Loaded.container else {
            throw NSFileProviderError(.providerNotFound)
        }
        let sync = try Loaded.shared.sync(identity: identity, container: container)
        if sync.settings.paused { throw NSFileProviderError(.serverUnreachable) }
        return sync
    }

    /// The workspaces with sync on that the person still belongs to, with their drives. One the
    /// person left is not in `/drives`, so its folder goes away. Item lookups and listings share
    /// one answer for a few seconds; the working set asks for a `fresh` one each time.
    public func workspaces(fresh: Bool = false) async throws -> [StorageSyncWorkspace] {
        let on = Set(settings.workspaces)
        let client = client
        return try await drives.get(fresh: fresh) { try await client.drives() }.workspaces.filter { on.contains($0.orgId) }
    }

    /// What a node's parent is on the server: a folder, or the top of a space or a teamspace.
    public static func place(of parent: ItemID) throws -> Place {
        switch parent {
        case let .space(orgId, space): return Place(orgId: orgId, parentId: nil, space: space)
        case let .teamspace(orgId, teamspaceId): return Place(orgId: orgId, parentId: nil, space: nil, teamspaceId: teamspaceId)
        case let .node(orgId, nodeId): return Place(orgId: orgId, parentId: nodeId, space: nil)
        // Nothing can be dropped beside the made-up levels.
        case .root, .workingSet, .trash, .workspace: throw NSFileProviderError(.cannotSynchronize)
        }
    }
}

/// Where a new node goes: into a folder (`parentId`), or at the top of a space or a teamspace.
public struct Place: Hashable, Sendable {
    public let orgId: String
    public let parentId: String?
    public let space: Space?
    public let teamspaceId: String?

    public init(orgId: String, parentId: String?, space: Space?, teamspaceId: String? = nil) {
        self.orgId = orgId
        self.parentId = parentId
        self.space = space
        self.teamspaceId = teamspaceId
    }
}

/// The `Sync` built from the current `sync.json`, and when that file last changed.
final class Loaded: @unchecked Sendable {
    static let shared = Loaded()
    static let identity = SharedIdentity()
    static let container = identity?.container

    private let lock = NSLock()
    private var current: (stamp: Stamp, sync: Sync)?

    /// The file as `stat` sees it: the app writes it atomically, so any write is a new inode.
    private struct Stamp: Equatable {
        let inode: UInt64
        let size: Int64
        let modified: Int
        let modifiedNanos: Int
    }

    func sync(identity: SharedIdentity, container: URL) throws -> Sync {
        let url = container.appendingPathComponent(SyncSettings.fileName)
        var info = stat()
        guard stat(url.path, &info) == 0 else {
            lock.withLock { current = nil }
            throw NSFileProviderError(.notAuthenticated)
        }
        let stamp = Stamp(
            inode: UInt64(info.st_ino), size: Int64(info.st_size),
            modified: info.st_mtimespec.tv_sec, modifiedNanos: info.st_mtimespec.tv_nsec
        )
        return try lock.withLock {
            if let current, current.stamp == stamp { return current.sync }
            guard let settings = SyncSettings.read(from: container) else { throw NSFileProviderError(.notAuthenticated) }
            let tokens = TokenStore(identity: identity, settings: { SyncSettings.read(from: container) })
            let sync = Sync(identity: identity, settings: settings, client: SyncClient(api: settings.api, tokens: tokens))
            current = (stamp, sync)
            return sync
        }
    }
}

/// `/drives`, kept a few seconds and asked once however many calls want it at the same moment.
actor DrivesCache {
    private static let keep: TimeInterval = 10
    private var answer: (value: StorageSyncDrivesResponse, at: Date)?
    private var running: Task<StorageSyncDrivesResponse, Error>?

    func get(fresh: Bool, _ fetch: @escaping @Sendable () async throws -> StorageSyncDrivesResponse) async throws -> StorageSyncDrivesResponse {
        if !fresh, let answer, Date().timeIntervalSince(answer.at) < Self.keep { return answer.value }
        if let running { return try await running.value }
        let task = Task { try await fetch() }
        running = task
        do {
            let value = try await task.value
            answer = (value, Date())
            running = nil
            return value
        } catch {
            running = nil
            throw error
        }
    }
}

/// At most `limit` at once across the whole process; the rest wait their turn, first come first
/// served. A wait the system cancels ends at once.
public actor Gate {
    private let limit: Int
    private var running = 0
    private var waiting: [(id: UUID, turn: CheckedContinuation<Void, Error>)] = []

    public init(_ limit: Int) { self.limit = limit }

    public nonisolated func run<T>(_ work: () async throws -> T) async throws -> T {
        try await enter()
        do {
            let value = try await work()
            await leave()
            return value
        } catch {
            await leave()
            throw error
        }
    }

    private func enter() async throws {
        if running < limit {
            running += 1
            return
        }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (turn: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    turn.resume(throwing: CancellationError())
                } else {
                    waiting.append((id, turn))
                }
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    private func cancel(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).turn.resume(throwing: CancellationError())
    }

    /// Hands the slot straight to the next in line, so `running` never drops and rises again.
    private func leave() {
        if waiting.isEmpty {
            running -= 1
        } else {
            waiting.removeFirst().turn.resume()
        }
    }
}

/// How much moves at once, for the whole extension. The system hands over a dropped folder as
/// one createItem per file, all at the same time; without these, ten thousand files would hash,
/// open uploads and send parts all at once.
public enum Transfers {
    /// Files hashed at once: the disk is the limit, and a hash reads the whole file.
    public static let hashing = Gate(2)
    /// Uploads open at once. Small files are mostly waiting on round trips, so a dozen overlap.
    public static let files = Gate(12)
    /// Parts on the wire at once, across every upload.
    public static let parts = Gate(8)
}

/// One listing per folder for a short while, by lowercased name, for re-imports
/// (`mayAlreadyExist`): every item of a folder asks whether the server already has its name, and
/// each asking for the whole folder again made a re-import of n files cost n listings.
public actor FolderIndex {
    public static let shared = FolderIndex()
    private static let keep: TimeInterval = 30

    private var listings: [Place: (at: Date, names: Task<[String: StorageNode], Error>)] = [:]

    /// The node named `name` (any case) in `place`, if the server has one.
    public func node(named name: String, in place: Place, sync: Sync) async throws -> StorageNode? {
        let now = Date()
        listings = listings.filter { now.timeIntervalSince($0.value.at) < Self.keep }
        let names: Task<[String: StorageNode], Error>
        if let listing = listings[place] {
            names = listing.names
        } else {
            let client = sync.client
            names = Task { try await Self.list(place, client: client) }
            listings[place] = (now, names)
        }
        do {
            return try await names.value[name.lowercased()]
        } catch {
            listings[place] = nil
            throw error
        }
    }

    private static func list(_ place: Place, client: SyncClient) async throws -> [String: StorageNode] {
        var names: [String: StorageNode] = [:]
        var cursor: String?
        repeat {
            let page = try await client.list(
                orgId: place.orgId, space: place.space ?? .personal, teamspaceId: place.teamspaceId,
                parentId: place.parentId, cursor: cursor, limit: pageSize
            )
            for node in page.nodes { names[node.name.lowercased()] = node }
            cursor = page.nextCursor
        } while cursor != nil
        return names
    }
}

/// Nodes per page asked of the server; it allows up to 200.
let pageSize = 200

/// The error the system hears for anything a call threw (docs/spec/desktop.md "Errors").
public func systemError(_ error: Error) -> Error {
    // Cancelled by the system (Finder's cancel, an eviction): it hears that, not a failure, so
    // it does not retry what nobody wants any more.
    if error is CancellationError || (error as? URLError)?.code == .cancelled {
        return CocoaError(.userCancelled)
    }
    switch error {
    case let error as SyncHTTPError:
        if error.status >= 500 {
            ErrorReporter.shared.report(stage: "sync", summary: "HTTP \(error.status) \(error.code ?? "")")
        }
        switch error.failure {
        case let .error(code): return NSFileProviderError(code)
        case .refreshToken: return NSFileProviderError(.notAuthenticated)
        case .versionConflict: return NSFileProviderError(.cannotSynchronize)
        }
    case is URLError: return NSFileProviderError(.serverUnreachable)
    case TokenError.signedOut: return NSFileProviderError(.notAuthenticated)
    // The grant is still good; the token endpoint could not answer now.
    case TokenError.unavailable: return NSFileProviderError(.serverUnreachable)
    case is TokenError: return NSFileProviderError(.notAuthenticated)
    default:
        let nsError = error as NSError
        // The extension's own answers (excluded file, paused, signed out) are expected, not failures.
        if nsError.domain == NSFileProviderErrorDomain { return error }
        ErrorReporter.shared.report(stage: "sync", summary: "\(type(of: error)) \(nsError.domain) \(nsError.code)")
        return error
    }
}

/// Runs `work` as a task the system can cancel through the returned `Progress`.
public func task(_ progress: Progress = Progress(totalUnitCount: 1), _ work: @escaping @Sendable () async -> Void) -> Progress {
    let running = Task { await work() }
    progress.cancellationHandler = { running.cancel() }
    return progress
}

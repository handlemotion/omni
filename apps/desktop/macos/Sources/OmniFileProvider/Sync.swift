import FileProvider
import OmniSyncClient
import OmniSyncCore
@preconcurrency import StorageSync

/// What every call of the extension needs: the shared identity and settings, and a client for
/// the server they name. Built per call, so a change to `sync.json` (a workspace switched on, a
/// pause) is seen without restarting the extension.
struct Sync {
    let identity: SharedIdentity
    let settings: SyncSettings
    let client: SyncClient

    static func load() throws -> Sync {
        guard let identity = SharedIdentity(), let container = identity.container else {
            throw NSFileProviderError(.providerNotFound)
        }
        guard let settings = SyncSettings.read(from: container) else {
            throw NSFileProviderError(.notAuthenticated)
        }
        if settings.paused { throw NSFileProviderError(.serverUnreachable) }
        let tokens = TokenStore(identity: identity, settings: { SyncSettings.read(from: container) })
        return Sync(identity: identity, settings: settings, client: SyncClient(api: settings.api, tokens: tokens))
    }

    /// The workspaces with sync on that the person still belongs to, with their drives. One the
    /// person left is not in `/drives`, so its folder goes away.
    func workspaces() async throws -> [StorageSyncWorkspace] {
        let on = Set(settings.workspaces)
        return try await client.drives().workspaces.filter { on.contains($0.orgId) }
    }

    /// What a node's parent is on the server: a folder, or the top of a space.
    static func place(of parent: ItemID) throws -> (orgId: String, parentId: String?, space: Space?) {
        switch parent {
        case let .space(orgId, space): return (orgId, nil, space)
        case let .node(orgId, nodeId): return (orgId, nodeId, nil)
        // Nothing can be dropped beside the made-up levels.
        case .root, .workingSet, .trash, .workspace: throw NSFileProviderError(.cannotSynchronize)
        }
    }
}

/// The error the system hears for anything a call threw (docs/spec/desktop.md "Errors").
func systemError(_ error: Error) -> Error {
    // Cancelled by the system (Finder's cancel, an eviction): it hears that, not a failure, so
    // it does not retry what nobody wants any more.
    if error is CancellationError || (error as? URLError)?.code == .cancelled {
        return CocoaError(.userCancelled)
    }
    switch error {
    case let error as SyncHTTPError:
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
    default: return error
    }
}

/// Runs `work` as a task the system can cancel through the returned `Progress`.
func task(_ progress: Progress = Progress(totalUnitCount: 1), _ work: @escaping @Sendable () async -> Void) -> Progress {
    let running = Task { await work() }
    progress.cancellationHandler = { running.cancel() }
    return progress
}

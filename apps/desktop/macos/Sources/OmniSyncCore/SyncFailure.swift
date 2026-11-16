import FileProvider

/// What the extension does with an answer that is not a success. The spec maps errors, it does
/// not invent them: the server refused, so the system hears that it refused.
public enum SyncFailure: Equatable, Sendable {
    /// `401`: refresh the token once and retry; a second `401` is `.notAuthenticated`.
    case refreshToken
    /// `409 version_conflict`: the server changed since the provider read it (spec "Conflicts").
    case versionConflict
    /// Hand this error to the system.
    case error(NSFileProviderError.Code)

    /// The answer to a response with `status` and, from the nested error body
    /// (`omni-error-format: 2`), its `code`. `refreshed` is true once a refresh was tried.
    public init(status: Int, code: String?, refreshed: Bool) {
        switch (status, code) {
        case (401, _): self = refreshed ? .error(.notAuthenticated) : .refreshToken
        case (402, _): self = .error(.insufficientQuota)
        case (404, _): self = .error(.noSuchItem)
        case (409, "version_conflict"): self = .versionConflict
        case (409, "name_taken"): self = .error(.filenameCollision)
        case (410, "cursor_expired"): self = .error(.syncAnchorExpired)
        case (429, _), (500..., _): self = .error(.serverUnreachable)
        // forbidden, locked, cycle, too_deep, parent_trashed, a refused move between workspaces:
        // the server said no, and retrying the same change will not change its mind.
        default: self = .error(.cannotSynchronize)
        }
    }

    /// No connection, a timeout, a dropped one: try again later.
    public init(_ error: URLError) {
        self = .error(.serverUnreachable)
    }
}

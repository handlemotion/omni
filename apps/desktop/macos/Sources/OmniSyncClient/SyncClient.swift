import Foundation
import OmniSyncCore
@preconcurrency import StorageSync

/// A refusal from the sync API: its status and, from the nested error body, its code.
public struct SyncHTTPError: Error, Equatable {
    public let status: Int
    public let code: String?

    /// What the extension does about it; a `401` here already survived one refresh.
    public var failure: SyncFailure { SyncFailure(status: status, code: code, refreshed: true) }
}

/// The Storage sync routes (`/api/storage/sync`, docs/spec/desktop.md "Routes"), with the bearer
/// token from `TokenStore`. Every call but `drives` names its workspace. A `401` refreshes the
/// token once and retries; any other refusal throws `SyncHTTPError`, a dropped connection its
/// `URLError`. Shapes are the generated `StorageSync` types only.
public final class SyncClient: Sendable {
    private let api: URL
    private let tokens: any AccessTokenSource
    private let session: URLSession

    public init(api: URL, tokens: any AccessTokenSource, session: URLSession = .shared) {
        self.api = api
        self.tokens = tokens
        self.session = session
    }

    // MARK: Reads

    public func drives() async throws -> StorageSyncDrivesResponse {
        try await json(get("drives"))
    }

    /// One page of a drive's change feed after `cursor`; no cursor lists the whole drive.
    public func changes(_ drive: Drive, cursor: String?) async throws -> StorageSyncChangesResponse {
        try await json(get("\(drive.orgId)/changes", ["space": drive.space.rawValue, "cursor": cursor]))
    }

    /// One node; `404` when it is gone or in Trash.
    public func node(orgId: String, id: String) async throws -> StorageNode {
        let answer: StorageNodeResponse = try await json(get("\(orgId)/nodes/\(id)"))
        return answer.node
    }

    /// One page of a folder, or of a space's top level when `parentId` is nil.
    public func list(orgId: String, space: Space, parentId: String?, cursor: String?) async throws -> StorageListResponse {
        let place: [String: String?] = parentId.map { ["parent": $0] } ?? ["space": space.rawValue]
        return try await json(get("\(orgId)/nodes", place.merging(["cursor": cursor]) { a, _ in a }))
    }

    // MARK: Changes

    public func createFolder(orgId: String, _ body: StorageCreateFolderBody) async throws -> StorageNode {
        let answer: StorageNodeResponse = try await json(send("POST", "\(orgId)/folders", body: body))
        return answer.node
    }

    /// A rename or a move (never both: the route takes one), guarded by the revision read.
    public func change(orgId: String, id: String, _ body: StorageChangeNodeBody, ifRevision: Int?) async throws -> StorageNode {
        let answer: StorageNodeResponse = try await json(
            send("PATCH", "\(orgId)/nodes/\(id)", query: ["ifRevision": ifRevision.map(String.init)], body: body)
        )
        return answer.node
    }

    /// To Trash on the server; delete in Finder never deletes for good.
    public func trash(orgId: String, id: String, ifRevision: Int?) async throws {
        let _: StorageNodeResponse = try await json(
            send("DELETE", "\(orgId)/nodes/\(id)", query: ["ifRevision": ifRevision.map(String.init)])
        )
    }

    // MARK: Uploads

    public func openUpload(orgId: String, _ body: StorageOpenUploadBody) async throws -> Upload {
        let answer: StorageUploadResponse = try await json(send("POST", "\(orgId)/uploads", body: body))
        return answer.upload
    }

    public func openReplace(orgId: String, _ body: StorageReplaceUploadBody) async throws -> Upload {
        let answer: StorageUploadResponse = try await json(send("POST", "\(orgId)/uploads", body: body))
        return answer.upload
    }

    /// The upload and its stored parts, to resume after the extension was stopped.
    public func upload(orgId: String, id: String) async throws -> Upload {
        let answer: StorageUploadResponse = try await json(get("\(orgId)/uploads/\(id)"))
        return answer.upload
    }

    public func putPart(orgId: String, uploadId: String, number: Int, bytes: Data) async throws {
        var request = try get("\(orgId)/uploads/\(uploadId)/parts/\(number)")
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        _ = try await perform(request, upload: bytes)
    }

    public func complete(orgId: String, uploadId: String) async throws -> StorageNode {
        let answer: StorageNodeResponse = try await json(send("POST", "\(orgId)/uploads/\(uploadId)/complete"))
        return answer.node
    }

    // MARK: Download

    /// A file's bytes, into a temporary file the caller moves, and the `ETag` they were served
    /// with (the stored object's, not the content version). `progress` follows the transfer and
    /// cancels it.
    public func download(orgId: String, id: String, progress: Progress) async throws -> (URL, String?) {
        let request = try get("\(orgId)/files/\(id)/content")
        let (url, response) = try await authorized(request) { request in
            let delegate = ProgressDelegate(progress)
            return try await self.session.download(for: request, delegate: delegate)
        }
        return (url, response.value(forHTTPHeaderField: "etag"))
    }

    // MARK: Plumbing

    private func get(_ path: String, _ query: [String: String?] = [:]) throws -> URLRequest {
        var components = URLComponents(url: api.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        components?.queryItems = items.isEmpty ? nil : items.sorted { $0.name < $1.name }
        guard let url = components?.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.setValue("2", forHTTPHeaderField: "omni-error-format")
        return request
    }

    private func send(_ method: String, _ path: String, query: [String: String?] = [:]) throws -> URLRequest {
        var request = try get(path, query)
        request.httpMethod = method
        return request
    }

    private func send<Body: Encodable>(_ method: String, _ path: String, query: [String: String?] = [:], body: Body) throws -> URLRequest {
        var request = try send(method, path, query: query)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    private func json<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data = try await perform(request, upload: nil)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func perform(_ request: URLRequest, upload: Data?) async throws -> Data {
        let (data, _) = try await authorized(request) { request in
            if let upload { return try await self.session.upload(for: request, from: upload) }
            return try await self.session.data(for: request)
        }
        return data
    }

    /// Sends with the current token; on `401`, once more with a refreshed one. Non-2xx throws.
    private func authorized<T>(
        _ request: URLRequest,
        _ send: @Sendable (URLRequest) async throws -> (T, URLResponse)
    ) async throws -> (T, HTTPURLResponse) {
        var token = try await tokens.accessToken()
        for attempt in 0..<2 {
            var request = request
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            let (value, response) = try await send(request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if (200..<300).contains(http.statusCode) { return (value, http) }
            if http.statusCode == 401, attempt == 0 {
                token = try await tokens.refresh(rejected: token)
                continue
            }
            throw SyncHTTPError(status: http.statusCode, code: Self.code(of: value))
        }
        throw SyncHTTPError(status: 401, code: "unauthorized")
    }

    /// `{ "error": { "code": … } }`, from a body in memory or a downloaded file.
    private static func code(of value: Any) -> String? {
        let data: Data? = (value as? Data) ?? (value as? URL).flatMap { try? Data(contentsOf: $0) }
        guard let data else { return nil }
        struct Body: Decodable {
            struct Inner: Decodable { let code: String? }
            let error: Inner?
        }
        return (try? JSONDecoder().decode(Body.self, from: data))?.error?.code
    }
}

/// Keeps a `Progress` in step with a download and cancels the task when it is cancelled.
private final class ProgressDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let progress: Progress

    init(_ progress: Progress) { self.progress = progress }

    func urlSession(_ session: URLSession, didCreateTask task: URLSessionTask) {
        progress.cancellationHandler = { task.cancel() }
    }

    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
    ) {
        if totalBytesExpectedToWrite > 0 { progress.totalUnitCount = totalBytesExpectedToWrite }
        progress.completedUnitCount = totalBytesWritten
    }

    // The async `download(for:delegate:)` hands the file back itself.
    func urlSession(_: URLSession, downloadTask _: URLSessionDownloadTask, didFinishDownloadingTo _: URL) {}
}

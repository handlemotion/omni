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

    public init(api: URL, tokens: any AccessTokenSource, session: URLSession = SyncClient.session) {
        self.api = api
        self.tokens = tokens
        self.session = session
    }

    /// The session every sync call shares. No response cache: change pages and listings are
    /// read once, and caching them only wrote each one to disk again. No cookies: the bearer
    /// token is the only credential.
    public static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: configuration)
    }()

    // MARK: Reads

    public func drives() async throws -> StorageSyncDrivesResponse {
        try await json(get("drives"))
    }

    /// One page of a drive's change feed after `cursor`; no cursor lists the whole drive.
    /// `limit` is capped by the server (200).
    public func changes(_ drive: Drive, cursor: String?, limit: Int? = nil) async throws -> StorageSyncChangesResponse {
        try await json(get("\(drive.orgId)/changes", ["space": drive.space.rawValue, "cursor": cursor, "limit": limit.map(String.init)]))
    }

    /// One node; `404` when it is gone or in Trash.
    public func node(orgId: String, id: String) async throws -> StorageNode {
        let answer: StorageNodeResponse = try await json(get("\(orgId)/nodes/\(id)"))
        return answer.node
    }

    /// One page of a folder, or of a space's top level when `parentId` is nil.
    public func list(orgId: String, space: Space, parentId: String?, cursor: String?, limit: Int? = nil) async throws -> StorageListResponse {
        let place: [String: String?] = parentId.map { ["parent": $0] } ?? ["space": space.rawValue]
        return try await json(get("\(orgId)/nodes", place.merging(["cursor": cursor, "limit": limit.map(String.init)]) { a, _ in a }))
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

    /// An upload of new bytes for file `id`, guarded by the content version the edit was based
    /// on: a newer one on the server answers `409 version_conflict` and opens nothing.
    public func openVersion(orgId: String, fileId: String, _ body: StorageOpenVersionBody) async throws -> Upload {
        let answer: StorageUploadResponse = try await json(send("POST", "\(orgId)/files/\(fileId)/versions", body: body))
        return answer.upload
    }

    /// The upload and its stored parts, to resume after the extension was stopped.
    public func upload(orgId: String, id: String) async throws -> Upload {
        let answer: StorageUploadResponse = try await json(get("\(orgId)/uploads/\(id)"))
        return answer.upload
    }

    /// Part `number`: `length` bytes of `file` from `offset`, read from disk as they are sent, so
    /// a part costs a small buffer, never its 16 MiB (`FileRange`).
    public func putPart(orgId: String, uploadId: String, number: Int, file: URL, offset: Int, length: Int) async throws {
        var request = try get("\(orgId)/uploads/\(uploadId)/parts/\(number)")
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
        // A streamed body is sent chunked unless its length is given, and the part's store
        // takes only a body of known length.
        request.setValue(String(length), forHTTPHeaderField: "content-length")
        _ = try await authorized(request) { request in
            let body = try FileRange(file: file, offset: offset, length: length)
            defer { body.finish() }
            var request = request
            request.httpBodyStream = body.stream
            return try await self.session.data(for: request)
        }
    }

    /// Makes the upload a file. For a new version, `ifContentVersion` checks the base once more:
    /// someone may have saved while the parts were on their way.
    public func complete(orgId: String, uploadId: String, ifContentVersion: Int? = nil) async throws -> StorageNode {
        let query = ["ifContentVersion": ifContentVersion.map(String.init)]
        let answer: StorageNodeResponse = try await json(send("POST", "\(orgId)/uploads/\(uploadId)/complete", query: query))
        return answer.node
    }

    /// Gives up an open upload and the space it held.
    public func abortUpload(orgId: String, uploadId: String) async throws {
        _ = try await perform(send("DELETE", "\(orgId)/uploads/\(uploadId)"))
    }

    // MARK: Download

    /// A file's bytes, into a temporary file the caller moves, and the `ETag` they were served
    /// with (the stored object's, not the content version). `progress` follows the transfer;
    /// cancelling the calling task cancels it.
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
        let data = try await perform(request)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let (data, _) = try await authorized(request) { request in
            try await self.session.data(for: request)
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
            // A refused download's body is an error, written to a file nobody else will remove.
            let code = Self.code(of: value)
            if let file = value as? URL { try? FileManager.default.removeItem(at: file) }
            if http.statusCode == 401, attempt == 0 {
                token = try await tokens.refresh(rejected: token)
                continue
            }
            throw SyncHTTPError(status: http.statusCode, code: code)
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

/// Keeps a `Progress` in step with a download. It leaves the progress's cancellation handler
/// alone: that one cancels the whole call (reads, download, move), and the async download stops
/// with its task. Replacing it with the transfer's own made cancel stop working once the bytes
/// were in.
private final class ProgressDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let progress: Progress

    init(_ progress: Progress) { self.progress = progress }

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

/// A byte range of a file as a request body. A thread of its own reads it with `pread`, 256 KiB at
/// a time, into one end of a bound stream pair; URLSession reads the other end as it sends. The
/// write blocks while the buffer is full, so memory stays at the buffer whatever the part size.
/// `finish` closes the reading end once the request is over, which ends a writer still waiting.
final class FileRange: @unchecked Sendable {
    static let bufferSize = 256 * 1024

    let stream: InputStream
    private let output: OutputStream
    private let descriptor: Int32
    private let offset: Int
    private let length: Int

    init(file: URL, offset: Int, length: Int) throws {
        let descriptor = open(file.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var input: InputStream?
        var output: OutputStream?
        Stream.getBoundStreams(withBufferSize: Self.bufferSize, inputStream: &input, outputStream: &output)
        guard let input, let output else {
            close(descriptor)
            throw POSIXError(.ENOMEM)
        }
        self.stream = input
        self.output = output
        self.descriptor = descriptor
        self.offset = offset
        self.length = length
        let writer = Thread { [self] in pump() }
        writer.name = "omni.sync.part"
        writer.start()
    }

    func finish() {
        stream.close()
    }

    private func pump() {
        output.open()
        defer {
            output.close()
            close(descriptor)
        }
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: Self.bufferSize)
        defer { buffer.deallocate() }
        var sent = 0
        while sent < length {
            let read = pread(descriptor, buffer, min(Self.bufferSize, length - sent), off_t(offset + sent))
            if read < 0, errno == EINTR { continue }
            // A file cut short sends less than the length promised, and the request fails.
            guard read > 0 else { return }
            var written = 0
            while written < read {
                let count = output.write(buffer + written, maxLength: read - written)
                // The request is over: nobody reads any more.
                guard count > 0 else { return }
                written += count
            }
            sent += read
        }
    }
}

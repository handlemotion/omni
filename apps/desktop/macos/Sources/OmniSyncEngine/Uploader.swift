import CryptoKit
import FileProvider
import OmniSyncClient
import OmniSyncCore
@preconcurrency import StorageSync

/// Sends a local file as an upload (docs/spec/desktop.md "Upload"): opens the upload, sends its
/// parts four at a time, completes. What it opened is kept in the App Group container under the
/// item's identifier (`UploadRecord`), so an extension stopped halfway resumes from the parts the
/// server already has (`GET /uploads/:id`) instead of starting over, but only for the same bytes.
///
/// Memory stays flat whatever the file's size: the hash reads through one reused buffer, and each
/// part streams from disk as it is sent (`SyncClient.putPart`). `Transfers` bounds how many files
/// and parts move at once across the whole extension.
public struct Uploader {
    let sync: Sync
    let orgId: String
    /// Where the open upload's record is kept while it runs.
    let key: String

    public init(sync: Sync, orgId: String, key: String) {
        self.sync = sync
        self.orgId = orgId
        self.key = key
    }

    private static let parallelParts = 4

    /// The bytes to send, measured once by the caller (`measure`).
    public struct Bytes {
        public let file: URL
        public let size: Int
        public let sha256: String
    }

    /// Uploads `bytes`. With `replaces`, as a new version of that file based on content version
    /// `ifContentVersion`, checked again on complete; `open` opens the matching upload.
    public func send(
        _ bytes: Bytes,
        replaces: String? = nil,
        ifContentVersion: Int? = nil,
        open: (_ size: Int, _ sha256: String) async throws -> Upload,
        progress: Progress
    ) async throws -> StorageNode {
        try await Transfers.files.run {
            try await sendNow(bytes, replaces: replaces, ifContentVersion: ifContentVersion, open: open, progress: progress)
        }
    }

    private func sendNow(
        _ bytes: Bytes,
        replaces: String?,
        ifContentVersion: Int?,
        open: (_ size: Int, _ sha256: String) async throws -> Upload,
        progress: Progress
    ) async throws -> StorageNode {
        var upload: Upload
        if let resumed = try await resume(bytes, replaces: replaces) {
            upload = resumed
        } else {
            upload = try await open(bytes.size, bytes.sha256)
        }
        // Kept until the file exists: a dropped connection or a stopped extension resumes.
        remember(UploadRecord(id: upload.id, size: bytes.size, sha256: bytes.sha256, replaces: replaces))
        if upload.nodeId == nil {
            upload = try await sendParts(of: bytes.file, upload: upload, progress: progress)
        }
        do {
            let node = try await sync.client.complete(orgId: orgId, uploadId: upload.id, ifContentVersion: ifContentVersion)
            forget()
            return node
        } catch let error as SyncHTTPError where error.failure == .versionConflict || error.status == 404 {
            // A newer version on the server, or the upload is gone: this one will never complete.
            // Give its space back now rather than when it expires. Any other refusal (full,
            // parts missing) keeps it, and the next try resumes it.
            forget()
            if error.status != 404 { try? await sync.client.abortUpload(orgId: orgId, uploadId: upload.id) }
            throw error
        }
    }

    private func sendParts(of file: URL, upload: Upload, progress: Progress) async throws -> Upload {
        let stored = Set(upload.parts.map(\.partNumber))
        let missing = upload.partCount == 0 ? [] : (1...upload.partCount).filter { !stored.contains($0) }
        progress.totalUnitCount = Int64(upload.size)
        progress.completedUnitCount = Int64(upload.parts.reduce(0) { $0 + $1.size })
        let client = sync.client
        let orgId = orgId
        try await withThrowingTaskGroup(of: Int.self) { group in
            var next = missing.makeIterator()
            func add() {
                guard let number = next.next() else { return }
                let offset = (number - 1) * upload.partSize
                let length = min(upload.partSize, upload.size - offset)
                group.addTask {
                    try await Transfers.parts.run {
                        try await client.putPart(orgId: orgId, uploadId: upload.id, number: number, file: file, offset: offset, length: length)
                    }
                    return length
                }
            }
            for _ in 0..<Self.parallelParts { add() }
            while let sent = try await group.next() {
                try Task.checkCancellation()
                progress.completedUnitCount += Int64(sent)
                add()
            }
        }
        return upload
    }

    /// The file's size and sha256. Read off Swift concurrency's few threads, so hashing a large
    /// file never holds up a listing, through one reused buffer, so memory does not grow with the
    /// file. Stops early when the calling task is cancelled.
    public static func measure(_ file: URL) async throws -> Bytes {
        try await Transfers.hashing.run { () async throws -> Bytes in
            let stop = StopFlag()
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (done: CheckedContinuation<Bytes, Error>) in
                    hashQueue.async { done.resume(with: Result { try hash(file, stop: stop) }) }
                }
            } onCancel: {
                stop.raise()
            }
        }
    }

    private static let hashQueue = DispatchQueue(label: "omni.sync.hash", qos: .userInitiated, attributes: .concurrent)

    private static func hash(_ file: URL, stop: StopFlag) throws -> Bytes {
        let descriptor = Darwin.open(file.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(descriptor) }
        let chunk = 4 << 20
        let buffer = UnsafeMutableRawBufferPointer.allocate(byteCount: chunk, alignment: 16)
        defer { buffer.deallocate() }
        var hash = SHA256()
        var size = 0
        while true {
            if stop.raised { throw CancellationError() }
            let count = read(descriptor, buffer.baseAddress, chunk)
            if count < 0 {
                if errno == EINTR { continue }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            if count == 0 { break }
            hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: buffer[0..<count]))
            size += count
        }
        return Bytes(file: file, size: size, sha256: hash.finalize().map { String(format: "%02x", $0) }.joined())
    }

    // MARK: Resume

    private var recordURL: URL? {
        sync.identity.container?.appendingPathComponent("uploads", isDirectory: true)
            .appendingPathComponent(Data(key.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_"))
    }

    /// The upload this item had open, if the server still has it and it is for these very bytes
    /// going to the same place. Any other is given up, so its parts never mix with these.
    private func resume(_ bytes: Bytes, replaces: String?) async throws -> Upload? {
        guard let recordURL, let data = try? Data(contentsOf: recordURL) else { return nil }
        guard let record = UploadRecord(data) else {
            forget()
            return nil
        }
        guard record.resumes(size: bytes.size, sha256: bytes.sha256, replaces: replaces) else {
            forget()
            try? await sync.client.abortUpload(orgId: orgId, uploadId: record.id)
            return nil
        }
        do {
            return try await sync.client.upload(orgId: orgId, id: record.id)
        } catch let error as SyncHTTPError where error.status == 404 {
            forget()
            return nil
        }
    }

    private func remember(_ record: UploadRecord) {
        guard let recordURL else { return }
        try? FileManager.default.createDirectory(at: recordURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? record.data.write(to: recordURL, options: .atomic)
    }

    private func forget() {
        if let recordURL { try? FileManager.default.removeItem(at: recordURL) }
    }
}

/// Set once when the system cancels a hash; read by the thread doing it.
private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false

    var raised: Bool { lock.withLock { stopped } }
    func raise() { lock.withLock { stopped = true } }
}

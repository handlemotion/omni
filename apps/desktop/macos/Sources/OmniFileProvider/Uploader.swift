import CryptoKit
import FileProvider
import OmniSyncClient
import OmniSyncCore
@preconcurrency import StorageSync

/// Sends a local file as an upload (docs/spec/desktop.md "Upload"): opens the upload, sends its
/// parts four at a time, completes. What it opened is kept in the App Group container under the
/// item's identifier (`UploadRecord`), so an extension stopped halfway resumes from the parts the
/// server already has (`GET /uploads/:id`) instead of starting over, but only for the same bytes.
struct Uploader {
    let sync: Sync
    let orgId: String
    /// Where the open upload's record is kept while it runs.
    let key: String

    private static let parallelParts = 4

    /// The bytes to send, measured once by the caller (`measure`).
    struct Bytes {
        let file: URL
        let size: Int
        let sha256: String
    }

    /// Uploads `bytes`. With `replaces`, as a new version of that file based on content version
    /// `ifContentVersion`, checked again on complete; `open` opens the matching upload.
    func send(
        _ bytes: Bytes,
        replaces: String? = nil,
        ifContentVersion: Int? = nil,
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
            func add() throws {
                guard let number = next.next() else { return }
                let bytes = try Self.part(number, of: file, partSize: upload.partSize, size: upload.size)
                group.addTask {
                    try await client.putPart(orgId: orgId, uploadId: upload.id, number: number, bytes: bytes)
                    return bytes.count
                }
            }
            for _ in 0..<Self.parallelParts { try add() }
            while let sent = try await group.next() {
                try Task.checkCancellation()
                progress.completedUnitCount += Int64(sent)
                try add()
            }
        }
        return upload
    }

    /// The file's size and sha256, read once in 1 MiB chunks.
    static func measure(_ file: URL) throws -> Bytes {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        var size = 0
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hash.update(data: chunk)
            size += chunk.count
        }
        return Bytes(file: file, size: size, sha256: hash.finalize().map { String(format: "%02x", $0) }.joined())
    }

    private static func part(_ number: Int, of file: URL, partSize: Int, size: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let offset = (number - 1) * partSize
        try handle.seek(toOffset: UInt64(offset))
        return try handle.read(upToCount: min(partSize, size - offset)) ?? Data()
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

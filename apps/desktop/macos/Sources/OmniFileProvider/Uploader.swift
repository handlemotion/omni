import CryptoKit
import FileProvider
import OmniSyncClient
@preconcurrency import StorageSync

/// Sends a local file as an upload (docs/spec/desktop.md "Upload"): hashes it, opens the upload,
/// sends its parts four at a time, completes. The upload's id is kept in the App Group container
/// under the item's identifier, so an extension stopped halfway resumes from the parts the
/// server already has (`GET /uploads/:id`) instead of starting over.
struct Uploader {
    let sync: Sync
    let orgId: String
    /// Where the open upload's id is kept while it runs.
    let key: String

    private static let parallelParts = 4

    func send(_ file: URL, open: (_ size: Int, _ sha256: String) async throws -> Upload, progress: Progress) async throws -> StorageNode {
        let (size, sha256) = try Self.measure(file)
        var upload: Upload
        if let resumed = try await resume(size: size) {
            upload = resumed
        } else {
            upload = try await open(size, sha256)
        }
        // Kept until the file exists: a dropped connection or a stopped extension resumes.
        remember(upload.id)
        if upload.nodeId == nil {
            upload = try await sendParts(of: file, upload: upload, progress: progress)
        }
        let node = try await sync.client.complete(orgId: orgId, uploadId: upload.id)
        forget()
        return node
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

    /// The size and sha256 of the bytes, read once in 1 MiB chunks.
    static func measure(_ file: URL) throws -> (Int, String) {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        var size = 0
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hash.update(data: chunk)
            size += chunk.count
        }
        return (size, hash.finalize().map { String(format: "%02x", $0) }.joined())
    }

    private static func part(_ number: Int, of file: URL, partSize: Int, size: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let offset = (number - 1) * partSize
        try handle.seek(toOffset: UInt64(offset))
        return try handle.read(upToCount: min(partSize, size - offset)) ?? Data()
    }

    // MARK: Resume

    private var record: URL? {
        sync.identity.container?.appendingPathComponent("uploads", isDirectory: true)
            .appendingPathComponent(Data(key.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_"))
    }

    /// The upload this item had open, if the server still has it and it is for bytes of this
    /// size. A file edited since gets a new upload; the old one expires on the server.
    private func resume(size: Int) async throws -> Upload? {
        guard let record, let id = try? String(contentsOf: record, encoding: .utf8) else { return nil }
        do {
            let upload = try await sync.client.upload(orgId: orgId, id: id)
            if upload.size == size { return upload }
            forget()
            return nil
        } catch let error as SyncHTTPError where error.status == 404 {
            forget()
            return nil
        }
    }

    private func remember(_ id: String) {
        guard let record else { return }
        try? FileManager.default.createDirectory(at: record.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? id.write(to: record, atomically: true, encoding: .utf8)
    }

    private func forget() {
        if let record { try? FileManager.default.removeItem(at: record) }
    }
}

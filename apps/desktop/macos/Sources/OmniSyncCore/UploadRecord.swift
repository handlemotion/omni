import Foundation

/// What the provider keeps about an open upload while it runs, in the App Group container under
/// the item's identifier (docs/spec/desktop.md "Upload"): enough to tell, after the extension was
/// stopped, whether the upload on the server is for the bytes on disk now. The server's upload
/// says only its size, so the hash and the file it replaces are kept here.
public struct UploadRecord: Codable, Equatable, Sendable {
    public let id: String
    public let size: Int
    public let sha256: String
    /// The file this upload is a new version of; nil for a new file.
    public let replaces: String?

    public init(id: String, size: Int, sha256: String, replaces: String?) {
        self.id = id
        self.size = size
        self.sha256 = sha256
        self.replaces = replaces
    }

    /// The record in `data`. A record from before hashes were kept (the bare upload id) reads as
    /// none, so its upload is never resumed for bytes it may not hold.
    public init?(_ data: Data) {
        guard let record = try? JSONDecoder().decode(Self.self, from: data) else { return nil }
        self = record
    }

    public var data: Data { (try? JSONEncoder().encode(self)) ?? Data() }

    /// Whether this upload may carry on with the bytes on disk now: the same bytes, going to the
    /// same place. A file edited back to the same size is different bytes, and resuming would
    /// store a file made of parts of both.
    public func resumes(size: Int, sha256: String, replaces: String?) -> Bool {
        self.size == size && self.sha256 == sha256 && self.replaces == replaces
    }
}

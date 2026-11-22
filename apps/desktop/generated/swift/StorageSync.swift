// Generated from @omni/contracts by packages/contracts/scripts/native-types.ts.
// Do not edit: run `pnpm --filter @omni/contracts native-types`.

// This file was generated from JSON Schema using quicktype, do not modify it directly.
// To parse the JSON, add this file to your project and do:
//
//   let space = try? JSONDecoder().decode(Space.self, from: jsonData)
//   let storageNodeSpace = try? JSONDecoder().decode(StorageNodeSpace.self, from: jsonData)
//   let storageNode = try StorageNode(json)
//   let storageNodeView = try StorageNodeView(json)
//   let storageListResponse = try StorageListResponse(json)
//   let storageNodeResponse = try StorageNodeResponse(json)
//   let storageCreateFolderBody = try StorageCreateFolderBody(json)
//   let storageChangeNodeBody = try StorageChangeNodeBody(json)
//   let storageOpenUploadBody = try StorageOpenUploadBody(json)
//   let storageOpenVersionBody = try StorageOpenVersionBody(json)
//   let storageUploadResponse = try StorageUploadResponse(json)
//   let storageUsage = try StorageUsage(json)
//   let storageSyncDrive = try StorageSyncDrive(json)
//   let storageSyncTeamspace = try StorageSyncTeamspace(json)
//   let storageSyncWorkspace = try StorageSyncWorkspace(json)
//   let storageSyncDrivesResponse = try StorageSyncDrivesResponse(json)
//   let storageSyncChange = try StorageSyncChange(json)
//   let storageSyncChangesResponse = try StorageSyncChangesResponse(json)
//   let storageChangedEvent = try StorageChangedEvent(json)
//   let desktopSyncState = try? JSONDecoder().decode(DesktopSyncState.self, from: jsonData)
//   let desktopWorkspaceSync = try DesktopWorkspaceSync(json)
//   let desktopSyncStatus = try DesktopSyncStatus(json)
//   let desktopSyncSignIn = try DesktopSyncSignIn(json)
//   let desktopSyncDone = try DesktopSyncDone(json)
//   let desktopSyncTokens = try DesktopSyncTokens(json)

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

import Foundation

// MARK: - StorageListResponse
public struct StorageListResponse: Codable, Equatable {
    public let folder: StorageNodeView?
    public let nextCursor: String?
    public let nodes: [StorageNode]

    public enum CodingKeys: String, CodingKey {
        case folder = "folder"
        case nextCursor = "nextCursor"
        case nodes = "nodes"
    }

    public init(folder: StorageNodeView?, nextCursor: String?, nodes: [StorageNode]) {
        self.folder = folder
        self.nextCursor = nextCursor
        self.nodes = nodes
    }
}

// MARK: StorageListResponse convenience initializers and mutators

public extension StorageListResponse {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageListResponse.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        folder: StorageNodeView?? = nil,
        nextCursor: String?? = nil,
        nodes: [StorageNode]? = nil
    ) -> StorageListResponse {
        return StorageListResponse(
            folder: folder ?? self.folder,
            nextCursor: nextCursor ?? self.nextCursor,
            nodes: nodes ?? self.nodes
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageNodeView
public struct StorageNodeView: Codable, Equatable {
    public let node: StorageNode
    public let path: [Path]
    public let role: Role

    public enum CodingKeys: String, CodingKey {
        case node = "node"
        case path = "path"
        case role = "role"
    }

    public init(node: StorageNode, path: [Path], role: Role) {
        self.node = node
        self.path = path
        self.role = role
    }
}

// MARK: StorageNodeView convenience initializers and mutators

public extension StorageNodeView {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageNodeView.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        node: StorageNode? = nil,
        path: [Path]? = nil,
        role: Role? = nil
    ) -> StorageNodeView {
        return StorageNodeView(
            node: node ?? self.node,
            path: path ?? self.path,
            role: role ?? self.role
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageNode
public struct StorageNode: Codable, Equatable {
    public let contentSha256: String?
    public let contentVersion: Int?
    public let createdAt: String
    public let createdByMemberId: String?
    public let id: String
    public let kind: Kind
    public let lockedAt: String?
    public let mimeType: String?
    public let name: String
    public let orgId: String
    public let ownerMemberId: String?
    public let parentId: String?
    public let revision: Int?
    public let size: Int
    public let space: StorageNodeSpace
    public let teamOnly: Bool?
    public let teamspaceId: String?
    public let trashedAt: String?
    public let updatedAt: String

    public enum CodingKeys: String, CodingKey {
        case contentSha256 = "contentSha256"
        case contentVersion = "contentVersion"
        case createdAt = "createdAt"
        case createdByMemberId = "createdByMemberId"
        case id = "id"
        case kind = "kind"
        case lockedAt = "lockedAt"
        case mimeType = "mimeType"
        case name = "name"
        case orgId = "orgId"
        case ownerMemberId = "ownerMemberId"
        case parentId = "parentId"
        case revision = "revision"
        case size = "size"
        case space = "space"
        case teamOnly = "teamOnly"
        case teamspaceId = "teamspaceId"
        case trashedAt = "trashedAt"
        case updatedAt = "updatedAt"
    }

    public init(contentSha256: String?, contentVersion: Int?, createdAt: String, createdByMemberId: String?, id: String, kind: Kind, lockedAt: String?, mimeType: String?, name: String, orgId: String, ownerMemberId: String?, parentId: String?, revision: Int?, size: Int, space: StorageNodeSpace, teamOnly: Bool?, teamspaceId: String?, trashedAt: String?, updatedAt: String) {
        self.contentSha256 = contentSha256
        self.contentVersion = contentVersion
        self.createdAt = createdAt
        self.createdByMemberId = createdByMemberId
        self.id = id
        self.kind = kind
        self.lockedAt = lockedAt
        self.mimeType = mimeType
        self.name = name
        self.orgId = orgId
        self.ownerMemberId = ownerMemberId
        self.parentId = parentId
        self.revision = revision
        self.size = size
        self.space = space
        self.teamOnly = teamOnly
        self.teamspaceId = teamspaceId
        self.trashedAt = trashedAt
        self.updatedAt = updatedAt
    }
}

// MARK: StorageNode convenience initializers and mutators

public extension StorageNode {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageNode.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        contentSha256: String?? = nil,
        contentVersion: Int?? = nil,
        createdAt: String? = nil,
        createdByMemberId: String?? = nil,
        id: String? = nil,
        kind: Kind? = nil,
        lockedAt: String?? = nil,
        mimeType: String?? = nil,
        name: String? = nil,
        orgId: String? = nil,
        ownerMemberId: String?? = nil,
        parentId: String?? = nil,
        revision: Int?? = nil,
        size: Int? = nil,
        space: StorageNodeSpace? = nil,
        teamOnly: Bool?? = nil,
        teamspaceId: String?? = nil,
        trashedAt: String?? = nil,
        updatedAt: String? = nil
    ) -> StorageNode {
        return StorageNode(
            contentSha256: contentSha256 ?? self.contentSha256,
            contentVersion: contentVersion ?? self.contentVersion,
            createdAt: createdAt ?? self.createdAt,
            createdByMemberId: createdByMemberId ?? self.createdByMemberId,
            id: id ?? self.id,
            kind: kind ?? self.kind,
            lockedAt: lockedAt ?? self.lockedAt,
            mimeType: mimeType ?? self.mimeType,
            name: name ?? self.name,
            orgId: orgId ?? self.orgId,
            ownerMemberId: ownerMemberId ?? self.ownerMemberId,
            parentId: parentId ?? self.parentId,
            revision: revision ?? self.revision,
            size: size ?? self.size,
            space: space ?? self.space,
            teamOnly: teamOnly ?? self.teamOnly,
            teamspaceId: teamspaceId ?? self.teamspaceId,
            trashedAt: trashedAt ?? self.trashedAt,
            updatedAt: updatedAt ?? self.updatedAt
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

public enum Kind: String, Codable, Equatable {
    case file = "file"
    case folder = "folder"
}

public enum StorageNodeSpace: String, Codable, Equatable {
    case personal = "personal"
    case shared = "shared"
    case teamspace = "teamspace"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - Path
public struct Path: Codable, Equatable {
    public let id: String
    public let name: String

    public enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
    }

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

// MARK: Path convenience initializers and mutators

public extension Path {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Path.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        id: String? = nil,
        name: String? = nil
    ) -> Path {
        return Path(
            id: id ?? self.id,
            name: name ?? self.name
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

public enum Role: String, Codable, Equatable {
    case commenter = "commenter"
    case editor = "editor"
    case member = "member"
    case viewer = "viewer"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageNodeResponse
public struct StorageNodeResponse: Codable, Equatable {
    public let node: StorageNode

    public enum CodingKeys: String, CodingKey {
        case node = "node"
    }

    public init(node: StorageNode) {
        self.node = node
    }
}

// MARK: StorageNodeResponse convenience initializers and mutators

public extension StorageNodeResponse {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageNodeResponse.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        node: StorageNode? = nil
    ) -> StorageNodeResponse {
        return StorageNodeResponse(
            node: node ?? self.node
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageCreateFolderBody
public struct StorageCreateFolderBody: Codable, Equatable {
    public let name: String
    public let parentId: String?
    public let space: Space?
    public let teamspaceId: String?

    public enum CodingKeys: String, CodingKey {
        case name = "name"
        case parentId = "parentId"
        case space = "space"
        case teamspaceId = "teamspaceId"
    }

    public init(name: String, parentId: String?, space: Space?, teamspaceId: String?) {
        self.name = name
        self.parentId = parentId
        self.space = space
        self.teamspaceId = teamspaceId
    }
}

// MARK: StorageCreateFolderBody convenience initializers and mutators

public extension StorageCreateFolderBody {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageCreateFolderBody.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        name: String? = nil,
        parentId: String?? = nil,
        space: Space?? = nil,
        teamspaceId: String?? = nil
    ) -> StorageCreateFolderBody {
        return StorageCreateFolderBody(
            name: name ?? self.name,
            parentId: parentId ?? self.parentId,
            space: space ?? self.space,
            teamspaceId: teamspaceId ?? self.teamspaceId
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

public enum Space: String, Codable, Equatable {
    case personal = "personal"
    case shared = "shared"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageChangeNodeBody
public struct StorageChangeNodeBody: Codable, Equatable {
    public let name: String?
    public let icon: Icon?
    public let parentId: String?
    public let space: Space?
    public let teamspaceId: String?

    public enum CodingKeys: String, CodingKey {
        case name = "name"
        case icon = "icon"
        case parentId = "parentId"
        case space = "space"
        case teamspaceId = "teamspaceId"
    }

    public init(name: String?, icon: Icon?, parentId: String?, space: Space?, teamspaceId: String?) {
        self.name = name
        self.icon = icon
        self.parentId = parentId
        self.space = space
        self.teamspaceId = teamspaceId
    }
}

// MARK: StorageChangeNodeBody convenience initializers and mutators

public extension StorageChangeNodeBody {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageChangeNodeBody.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        name: String?? = nil,
        icon: Icon?? = nil,
        parentId: String?? = nil,
        space: Space?? = nil,
        teamspaceId: String?? = nil
    ) -> StorageChangeNodeBody {
        return StorageChangeNodeBody(
            name: name ?? self.name,
            icon: icon ?? self.icon,
            parentId: parentId ?? self.parentId,
            space: space ?? self.space,
            teamspaceId: teamspaceId ?? self.teamspaceId
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

public enum Icon: String, Codable, Equatable {
    case analytics = "analytics"
    case archive = "archive"
    case book = "book"
    case brush = "brush"
    case buildings = "buildings"
    case code = "code"
    case coins = "coins"
    case globe = "globe"
    case heart = "heart"
    case home = "home"
    case lightBulb = "light-bulb"
    case lock = "lock"
    case megaphone = "megaphone"
    case package = "package"
    case rocket = "rocket"
    case sparkle = "sparkle"
    case star = "star"
    case target = "target"
    case trophy = "trophy"
    case video = "video"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageOpenUploadBody
public struct StorageOpenUploadBody: Codable, Equatable {
    public let mimeType: String?
    public let name: String
    public let parentId: String?
    public let sha256: String?
    public let size: Int
    public let space: Space?
    public let teamspaceId: String?

    public enum CodingKeys: String, CodingKey {
        case mimeType = "mimeType"
        case name = "name"
        case parentId = "parentId"
        case sha256 = "sha256"
        case size = "size"
        case space = "space"
        case teamspaceId = "teamspaceId"
    }

    public init(mimeType: String?, name: String, parentId: String?, sha256: String?, size: Int, space: Space?, teamspaceId: String?) {
        self.mimeType = mimeType
        self.name = name
        self.parentId = parentId
        self.sha256 = sha256
        self.size = size
        self.space = space
        self.teamspaceId = teamspaceId
    }
}

// MARK: StorageOpenUploadBody convenience initializers and mutators

public extension StorageOpenUploadBody {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageOpenUploadBody.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        mimeType: String?? = nil,
        name: String? = nil,
        parentId: String?? = nil,
        sha256: String?? = nil,
        size: Int? = nil,
        space: Space?? = nil,
        teamspaceId: String?? = nil
    ) -> StorageOpenUploadBody {
        return StorageOpenUploadBody(
            mimeType: mimeType ?? self.mimeType,
            name: name ?? self.name,
            parentId: parentId ?? self.parentId,
            sha256: sha256 ?? self.sha256,
            size: size ?? self.size,
            space: space ?? self.space,
            teamspaceId: teamspaceId ?? self.teamspaceId
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageOpenVersionBody
public struct StorageOpenVersionBody: Codable, Equatable {
    public let ifContentVersion: Int?
    public let mimeType: String?
    public let sha256: String?
    public let size: Int

    public enum CodingKeys: String, CodingKey {
        case ifContentVersion = "ifContentVersion"
        case mimeType = "mimeType"
        case sha256 = "sha256"
        case size = "size"
    }

    public init(ifContentVersion: Int?, mimeType: String?, sha256: String?, size: Int) {
        self.ifContentVersion = ifContentVersion
        self.mimeType = mimeType
        self.sha256 = sha256
        self.size = size
    }
}

// MARK: StorageOpenVersionBody convenience initializers and mutators

public extension StorageOpenVersionBody {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageOpenVersionBody.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        ifContentVersion: Int?? = nil,
        mimeType: String?? = nil,
        sha256: String?? = nil,
        size: Int? = nil
    ) -> StorageOpenVersionBody {
        return StorageOpenVersionBody(
            ifContentVersion: ifContentVersion ?? self.ifContentVersion,
            mimeType: mimeType ?? self.mimeType,
            sha256: sha256 ?? self.sha256,
            size: size ?? self.size
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageUploadResponse
public struct StorageUploadResponse: Codable, Equatable {
    public let upload: Upload

    public enum CodingKeys: String, CodingKey {
        case upload = "upload"
    }

    public init(upload: Upload) {
        self.upload = upload
    }
}

// MARK: StorageUploadResponse convenience initializers and mutators

public extension StorageUploadResponse {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageUploadResponse.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        upload: Upload? = nil
    ) -> StorageUploadResponse {
        return StorageUploadResponse(
            upload: upload ?? self.upload
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - Upload
public struct Upload: Codable, Equatable {
    public let expiresAt: String
    public let id: String
    public let mimeType: String?
    public let name: String
    public let nodeId: String?
    public let parentId: String?
    public let partCount: Int
    public let parts: [Part]
    public let partSize: Int
    public let size: Int
    public let space: StorageNodeSpace
    public let teamspaceId: String?

    public enum CodingKeys: String, CodingKey {
        case expiresAt = "expiresAt"
        case id = "id"
        case mimeType = "mimeType"
        case name = "name"
        case nodeId = "nodeId"
        case parentId = "parentId"
        case partCount = "partCount"
        case parts = "parts"
        case partSize = "partSize"
        case size = "size"
        case space = "space"
        case teamspaceId = "teamspaceId"
    }

    public init(expiresAt: String, id: String, mimeType: String?, name: String, nodeId: String?, parentId: String?, partCount: Int, parts: [Part], partSize: Int, size: Int, space: StorageNodeSpace, teamspaceId: String?) {
        self.expiresAt = expiresAt
        self.id = id
        self.mimeType = mimeType
        self.name = name
        self.nodeId = nodeId
        self.parentId = parentId
        self.partCount = partCount
        self.parts = parts
        self.partSize = partSize
        self.size = size
        self.space = space
        self.teamspaceId = teamspaceId
    }
}

// MARK: Upload convenience initializers and mutators

public extension Upload {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Upload.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        expiresAt: String? = nil,
        id: String? = nil,
        mimeType: String?? = nil,
        name: String? = nil,
        nodeId: String?? = nil,
        parentId: String?? = nil,
        partCount: Int? = nil,
        parts: [Part]? = nil,
        partSize: Int? = nil,
        size: Int? = nil,
        space: StorageNodeSpace? = nil,
        teamspaceId: String?? = nil
    ) -> Upload {
        return Upload(
            expiresAt: expiresAt ?? self.expiresAt,
            id: id ?? self.id,
            mimeType: mimeType ?? self.mimeType,
            name: name ?? self.name,
            nodeId: nodeId ?? self.nodeId,
            parentId: parentId ?? self.parentId,
            partCount: partCount ?? self.partCount,
            parts: parts ?? self.parts,
            partSize: partSize ?? self.partSize,
            size: size ?? self.size,
            space: space ?? self.space,
            teamspaceId: teamspaceId ?? self.teamspaceId
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - Part
public struct Part: Codable, Equatable {
    public let partNumber: Int
    public let size: Int

    public enum CodingKeys: String, CodingKey {
        case partNumber = "partNumber"
        case size = "size"
    }

    public init(partNumber: Int, size: Int) {
        self.partNumber = partNumber
        self.size = size
    }
}

// MARK: Part convenience initializers and mutators

public extension Part {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Part.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        partNumber: Int? = nil,
        size: Int? = nil
    ) -> Part {
        return Part(
            partNumber: partNumber ?? self.partNumber,
            size: size ?? self.size
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageUsage
public struct StorageUsage: Codable, Equatable {
    public let allowanceBytes: Double?
    public let limitBytes: Double?
    public let overage: Overage?
    public let reservedBytes: Int
    public let uploadsBlocked: UploadsBlocked?
    public let usedBytes: Int

    public enum CodingKeys: String, CodingKey {
        case allowanceBytes = "allowanceBytes"
        case limitBytes = "limitBytes"
        case overage = "overage"
        case reservedBytes = "reservedBytes"
        case uploadsBlocked = "uploadsBlocked"
        case usedBytes = "usedBytes"
    }

    public init(allowanceBytes: Double?, limitBytes: Double?, overage: Overage?, reservedBytes: Int, uploadsBlocked: UploadsBlocked?, usedBytes: Int) {
        self.allowanceBytes = allowanceBytes
        self.limitBytes = limitBytes
        self.overage = overage
        self.reservedBytes = reservedBytes
        self.uploadsBlocked = uploadsBlocked
        self.usedBytes = usedBytes
    }
}

// MARK: StorageUsage convenience initializers and mutators

public extension StorageUsage {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageUsage.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        allowanceBytes: Double?? = nil,
        limitBytes: Double?? = nil,
        overage: Overage?? = nil,
        reservedBytes: Int? = nil,
        uploadsBlocked: UploadsBlocked?? = nil,
        usedBytes: Int? = nil
    ) -> StorageUsage {
        return StorageUsage(
            allowanceBytes: allowanceBytes ?? self.allowanceBytes,
            limitBytes: limitBytes ?? self.limitBytes,
            overage: overage ?? self.overage,
            reservedBytes: reservedBytes ?? self.reservedBytes,
            uploadsBlocked: uploadsBlocked ?? self.uploadsBlocked,
            usedBytes: usedBytes ?? self.usedBytes
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - Overage
public struct Overage: Codable, Equatable {
    public let extraGb: Int

    public enum CodingKeys: String, CodingKey {
        case extraGb = "extraGb"
    }

    public init(extraGb: Int) {
        self.extraGb = extraGb
    }
}

// MARK: Overage convenience initializers and mutators

public extension Overage {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(Overage.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        extraGb: Int? = nil
    ) -> Overage {
        return Overage(
            extraGb: extraGb ?? self.extraGb
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

public enum UploadsBlocked: String, Codable, Equatable {
    case billingInactive = "billing_inactive"
    case storageFull = "storage_full"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageSyncDrivesResponse
public struct StorageSyncDrivesResponse: Codable, Equatable {
    public let workspaces: [StorageSyncWorkspace]

    public enum CodingKeys: String, CodingKey {
        case workspaces = "workspaces"
    }

    public init(workspaces: [StorageSyncWorkspace]) {
        self.workspaces = workspaces
    }
}

// MARK: StorageSyncDrivesResponse convenience initializers and mutators

public extension StorageSyncDrivesResponse {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageSyncDrivesResponse.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        workspaces: [StorageSyncWorkspace]? = nil
    ) -> StorageSyncDrivesResponse {
        return StorageSyncDrivesResponse(
            workspaces: workspaces ?? self.workspaces
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageSyncWorkspace
public struct StorageSyncWorkspace: Codable, Equatable {
    public let drives: [StorageSyncDrive]
    public let name: String
    public let orgId: String
    public let teamspaces: [StorageSyncTeamspace]?

    public enum CodingKeys: String, CodingKey {
        case drives = "drives"
        case name = "name"
        case orgId = "orgId"
        case teamspaces = "teamspaces"
    }

    public init(drives: [StorageSyncDrive], name: String, orgId: String, teamspaces: [StorageSyncTeamspace]?) {
        self.drives = drives
        self.name = name
        self.orgId = orgId
        self.teamspaces = teamspaces
    }
}

// MARK: StorageSyncWorkspace convenience initializers and mutators

public extension StorageSyncWorkspace {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageSyncWorkspace.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        drives: [StorageSyncDrive]? = nil,
        name: String? = nil,
        orgId: String? = nil,
        teamspaces: [StorageSyncTeamspace]?? = nil
    ) -> StorageSyncWorkspace {
        return StorageSyncWorkspace(
            drives: drives ?? self.drives,
            name: name ?? self.name,
            orgId: orgId ?? self.orgId,
            teamspaces: teamspaces ?? self.teamspaces
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageSyncDrive
public struct StorageSyncDrive: Codable, Equatable {
    public let revision: Int
    public let space: Space

    public enum CodingKeys: String, CodingKey {
        case revision = "revision"
        case space = "space"
    }

    public init(revision: Int, space: Space) {
        self.revision = revision
        self.space = space
    }
}

// MARK: StorageSyncDrive convenience initializers and mutators

public extension StorageSyncDrive {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageSyncDrive.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        revision: Int? = nil,
        space: Space? = nil
    ) -> StorageSyncDrive {
        return StorageSyncDrive(
            revision: revision ?? self.revision,
            space: space ?? self.space
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageSyncTeamspace
public struct StorageSyncTeamspace: Codable, Equatable {
    public let id: String
    public let name: String
    public let revision: Int

    public enum CodingKeys: String, CodingKey {
        case id = "id"
        case name = "name"
        case revision = "revision"
    }

    public init(id: String, name: String, revision: Int) {
        self.id = id
        self.name = name
        self.revision = revision
    }
}

// MARK: StorageSyncTeamspace convenience initializers and mutators

public extension StorageSyncTeamspace {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageSyncTeamspace.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        id: String? = nil,
        name: String? = nil,
        revision: Int? = nil
    ) -> StorageSyncTeamspace {
        return StorageSyncTeamspace(
            id: id ?? self.id,
            name: name ?? self.name,
            revision: revision ?? self.revision
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageSyncChangesResponse
public struct StorageSyncChangesResponse: Codable, Equatable {
    public let changes: [StorageSyncChange]
    public let more: Bool
    public let nextCursor: String

    public enum CodingKeys: String, CodingKey {
        case changes = "changes"
        case more = "more"
        case nextCursor = "nextCursor"
    }

    public init(changes: [StorageSyncChange], more: Bool, nextCursor: String) {
        self.changes = changes
        self.more = more
        self.nextCursor = nextCursor
    }
}

// MARK: StorageSyncChangesResponse convenience initializers and mutators

public extension StorageSyncChangesResponse {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageSyncChangesResponse.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        changes: [StorageSyncChange]? = nil,
        more: Bool? = nil,
        nextCursor: String? = nil
    ) -> StorageSyncChangesResponse {
        return StorageSyncChangesResponse(
            changes: changes ?? self.changes,
            more: more ?? self.more,
            nextCursor: nextCursor ?? self.nextCursor
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageSyncChange
public struct StorageSyncChange: Codable, Equatable {
    public let gone: Bool?
    public let id: String
    public let inTrash: Bool
    public let node: StorageNode?
    public let revision: Int

    public enum CodingKeys: String, CodingKey {
        case gone = "gone"
        case id = "id"
        case inTrash = "inTrash"
        case node = "node"
        case revision = "revision"
    }

    public init(gone: Bool?, id: String, inTrash: Bool, node: StorageNode?, revision: Int) {
        self.gone = gone
        self.id = id
        self.inTrash = inTrash
        self.node = node
        self.revision = revision
    }
}

// MARK: StorageSyncChange convenience initializers and mutators

public extension StorageSyncChange {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageSyncChange.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        gone: Bool?? = nil,
        id: String? = nil,
        inTrash: Bool? = nil,
        node: StorageNode?? = nil,
        revision: Int? = nil
    ) -> StorageSyncChange {
        return StorageSyncChange(
            gone: gone ?? self.gone,
            id: id ?? self.id,
            inTrash: inTrash ?? self.inTrash,
            node: node ?? self.node,
            revision: revision ?? self.revision
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - StorageChangedEvent
public struct StorageChangedEvent: Codable, Equatable {
    public let parentIds: [String?]?
    public let space: StorageNodeSpace
    public let teamspaceId: String?
    public let type: TypeEnum

    public enum CodingKeys: String, CodingKey {
        case parentIds = "parentIds"
        case space = "space"
        case teamspaceId = "teamspaceId"
        case type = "type"
    }

    public init(parentIds: [String?]?, space: StorageNodeSpace, teamspaceId: String?, type: TypeEnum) {
        self.parentIds = parentIds
        self.space = space
        self.teamspaceId = teamspaceId
        self.type = type
    }
}

// MARK: StorageChangedEvent convenience initializers and mutators

public extension StorageChangedEvent {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(StorageChangedEvent.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        parentIds: [String?]?? = nil,
        space: StorageNodeSpace? = nil,
        teamspaceId: String?? = nil,
        type: TypeEnum? = nil
    ) -> StorageChangedEvent {
        return StorageChangedEvent(
            parentIds: parentIds ?? self.parentIds,
            space: space ?? self.space,
            teamspaceId: teamspaceId ?? self.teamspaceId,
            type: type ?? self.type
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

public enum TypeEnum: String, Codable, Equatable {
    case storageChanged = "storage.changed"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - DesktopSyncStatus
public struct DesktopSyncStatus: Codable, Equatable {
    public let available: Bool
    public let workspaces: [DesktopWorkspaceSync]

    public enum CodingKeys: String, CodingKey {
        case available = "available"
        case workspaces = "workspaces"
    }

    public init(available: Bool, workspaces: [DesktopWorkspaceSync]) {
        self.available = available
        self.workspaces = workspaces
    }
}

// MARK: DesktopSyncStatus convenience initializers and mutators

public extension DesktopSyncStatus {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(DesktopSyncStatus.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        available: Bool? = nil,
        workspaces: [DesktopWorkspaceSync]? = nil
    ) -> DesktopSyncStatus {
        return DesktopSyncStatus(
            available: available ?? self.available,
            workspaces: workspaces ?? self.workspaces
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - DesktopWorkspaceSync
public struct DesktopWorkspaceSync: Codable, Equatable {
    public let orgId: String
    public let state: DesktopSyncState

    public enum CodingKeys: String, CodingKey {
        case orgId = "orgId"
        case state = "state"
    }

    public init(orgId: String, state: DesktopSyncState) {
        self.orgId = orgId
        self.state = state
    }
}

// MARK: DesktopWorkspaceSync convenience initializers and mutators

public extension DesktopWorkspaceSync {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(DesktopWorkspaceSync.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        orgId: String? = nil,
        state: DesktopSyncState? = nil
    ) -> DesktopWorkspaceSync {
        return DesktopWorkspaceSync(
            orgId: orgId ?? self.orgId,
            state: state ?? self.state
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

public enum DesktopSyncState: String, Codable, Equatable {
    case needsAttention = "needs_attention"
    case off = "off"
    case paused = "paused"
    case synced = "synced"
    case syncing = "syncing"
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - DesktopSyncSignIn
public struct DesktopSyncSignIn: Codable, Equatable {
    public let url: String

    public enum CodingKeys: String, CodingKey {
        case url = "url"
    }

    public init(url: String) {
        self.url = url
    }
}

// MARK: DesktopSyncSignIn convenience initializers and mutators

public extension DesktopSyncSignIn {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(DesktopSyncSignIn.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        url: String? = nil
    ) -> DesktopSyncSignIn {
        return DesktopSyncSignIn(
            url: url ?? self.url
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - DesktopSyncDone
public struct DesktopSyncDone: Codable, Equatable {
    public let ok: Bool

    public enum CodingKeys: String, CodingKey {
        case ok = "ok"
    }

    public init(ok: Bool) {
        self.ok = ok
    }
}

// MARK: DesktopSyncDone convenience initializers and mutators

public extension DesktopSyncDone {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(DesktopSyncDone.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        ok: Bool? = nil
    ) -> DesktopSyncDone {
        return DesktopSyncDone(
            ok: ok ?? self.ok
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

//
// Hashable or Equatable:
// The compiler will not be able to synthesize the implementation of Hashable or Equatable
// for types that require the use of JSONAny, nor will the implementation of Hashable be
// synthesized for types that have collections (such as arrays or dictionaries).

// MARK: - DesktopSyncTokens
public struct DesktopSyncTokens: Codable, Equatable {
    public let accessToken: String
    public let expiresAt: Double
    public let refreshToken: String

    public enum CodingKeys: String, CodingKey {
        case accessToken = "accessToken"
        case expiresAt = "expiresAt"
        case refreshToken = "refreshToken"
    }

    public init(accessToken: String, expiresAt: Double, refreshToken: String) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.refreshToken = refreshToken
    }
}

// MARK: DesktopSyncTokens convenience initializers and mutators

public extension DesktopSyncTokens {
    init(data: Data) throws {
        self = try newJSONDecoder().decode(DesktopSyncTokens.self, from: data)
    }

    init(_ json: String, using encoding: String.Encoding = .utf8) throws {
        guard let data = json.data(using: encoding) else {
            throw NSError(domain: "JSONDecoding", code: 0, userInfo: nil)
        }
        try self.init(data: data)
    }

    init(fromURL url: URL) throws {
        try self.init(data: try Data(contentsOf: url))
    }

    func with(
        accessToken: String? = nil,
        expiresAt: Double? = nil,
        refreshToken: String? = nil
    ) -> DesktopSyncTokens {
        return DesktopSyncTokens(
            accessToken: accessToken ?? self.accessToken,
            expiresAt: expiresAt ?? self.expiresAt,
            refreshToken: refreshToken ?? self.refreshToken
        )
    }

    func jsonData() throws -> Data {
        return try newJSONEncoder().encode(self)
    }

    func jsonString(encoding: String.Encoding = .utf8) throws -> String? {
        return String(data: try self.jsonData(), encoding: encoding)
    }
}

// MARK: - Helper functions for creating encoders and decoders

func newJSONDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    if #available(iOS 10.0, OSX 10.12, tvOS 10.0, watchOS 3.0, *) {
        decoder.dateDecodingStrategy = .iso8601
    }
    return decoder
}

func newJSONEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    if #available(iOS 10.0, OSX 10.12, tvOS 10.0, watchOS 3.0, *) {
        encoder.dateEncodingStrategy = .iso8601
    }
    return encoder
}

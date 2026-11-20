import FileProvider
import Foundation
@testable import OmniSyncCore
@preconcurrency import StorageSync
import Testing

private let org = "0193a0b2-0000-7000-8000-000000000001"
private let nodeId = "0193a0b2-0000-7000-8000-0000000000aa"

private func node(
    id: String = nodeId,
    kind: Kind = .file,
    parentId: String? = nil,
    space: Space = .personal,
    contentVersion: Int? = 3,
    revision: Int? = 41,
    lockedAt: String? = nil
) -> StorageNode {
    StorageNode(
        contentSha256: nil, contentVersion: contentVersion, createdAt: "2026-11-16T00:00:00Z",
        createdByMemberId: nil, id: id, kind: kind, lockedAt: lockedAt, mimeType: nil, name: "a.txt",
        orgId: org, ownerMemberId: nil, parentId: parentId, revision: revision, size: 1, space: space,
        trashedAt: nil, updatedAt: "2026-11-16T00:00:00Z"
    )
}

@Test func identifiersRoundTripSoEveryCallReachesTheRightWorkspace() {
    for item in [
        ItemID.root, .workingSet, .trash, .workspace(orgId: org),
        .space(orgId: org, space: .personal), .space(orgId: org, space: .shared),
        .node(orgId: org, nodeId: nodeId),
    ] {
        #expect(ItemID(item.identifier) == item)
    }
}

@Test func malformedIdentifiersAreRefusedInsteadOfCallingAGuessedWorkspace() {
    for raw in ["", nodeId, "ws:", "space:\(org):trash", "space:\(org)", ":\(nodeId)", "\(org):", "a:b:c"] {
        #expect(ItemID(NSFileProviderItemIdentifier(raw)) == nil, "\(raw)")
    }
}

@Test func topLevelNodesSitInTheirSpaceFolderNotTheWorkspaceRoot() {
    #expect(ItemID.parent(of: node(space: .shared)) == .space(orgId: org, space: .shared))
    #expect(ItemID.parent(of: node(parentId: "p")) == .node(orgId: org, nodeId: "p"))
}

@Test func renamingAFileDoesNotLookLikeNewContent() {
    let before = itemVersion(of: node(revision: 41))
    let after = itemVersion(of: node(revision: 42))
    #expect(before.contentVersion == after.contentVersion)
    #expect(before.metadataVersion != after.metadataVersion)
    #expect(contentVersion(of: after) == 3)
}

@Test func aFolderNeverAsksForItsContentAgain() {
    let folder = node(kind: .folder, contentVersion: nil)
    #expect(itemVersion(of: folder).contentVersion == itemVersion(of: node(kind: .folder, contentVersion: 7)).contentVersion)
}

@Test func aForeignVersionIsNotSentAsAnUpdateGuard() {
    let version = NSFileProviderItemVersion(contentVersion: Data("x".utf8), metadataVersion: Data())
    #expect(contentVersion(of: version) == nil)
}

@Test func madeUpLevelsCannotBeRenamedMovedOrDeleted() {
    for item in [ItemID.root, .workspace(orgId: org), .space(orgId: org, space: .personal)] {
        let caps = capabilities(of: item)
        #expect(!caps.contains(.allowsRenaming) && !caps.contains(.allowsReparenting) && !caps.contains(.allowsDeleting))
    }
    #expect(!capabilities(of: .workspace(orgId: org)).contains(.allowsAddingSubItems))
    #expect(capabilities(of: .space(orgId: org, space: .shared)).contains(.allowsAddingSubItems))
}

@Test func aLockedFileIsReadOnlyBeforeTheServerHasToRefuse() {
    let caps = capabilities(of: .node(orgId: org, nodeId: nodeId), node: node(lockedAt: "2026-11-16T00:00:00Z"))
    #expect(caps == [.allowsReading, .allowsExcludingFromSync])
}

@Test func anAnchorWithTheSameCursorsIsTheSameBytes() throws {
    var a = SyncAnchor()
    a.set("c1", for: Drive(orgId: "b", space: .shared))
    a.set("c2", for: Drive(orgId: "a", space: .personal))
    var b = SyncAnchor()
    b.set("c2", for: Drive(orgId: "a", space: .personal))
    b.set("c1", for: Drive(orgId: "b", space: .shared))
    #expect(a.anchor == b.anchor)
    #expect(try SyncAnchor(a.anchor) == a)
}

@Test func anUnreadableAnchorRestartsEnumerationInsteadOfFailingForever() {
    #expect(throws: NSFileProviderError.self) { try SyncAnchor(NSFileProviderSyncAnchor(Data("v1".utf8))) }
}

@Test func aWorkspaceTurnedOnStartsFromTheBeginningAndOneTurnedOffIsDropped() {
    let kept = Drive(orgId: "a", space: .personal)
    let off = Drive(orgId: "b", space: .personal)
    var anchor = SyncAnchor()
    anchor.set("c1", for: kept)
    anchor.set("c2", for: off)
    let added = Drive(orgId: "c", space: .personal)
    let next = anchor.keeping([kept, added])
    #expect(next.cursor(for: kept) == "c1")
    #expect(next.cursor(for: off) == nil)
    #expect(next.cursor(for: added) == nil)
}

@Test func aNodeMovedToTheOtherSpaceIsNotDeletedWhicheverFeedComesFirst() {
    let moved = node(space: .shared)
    for changes in [
        [StorageSyncChange(gone: nil, id: nodeId, inTrash: false, node: nil, revision: 5),
         StorageSyncChange(gone: nil, id: nodeId, inTrash: false, node: moved, revision: 6)],
        [StorageSyncChange(gone: nil, id: nodeId, inTrash: false, node: moved, revision: 6),
         StorageSyncChange(gone: nil, id: nodeId, inTrash: false, node: nil, revision: 5)],
    ] {
        let batch = ChangeBatch(orgId: org, changes: changes)
        #expect(batch.updated == [moved])
        #expect(batch.deleted.isEmpty && batch.unresolved.isEmpty)
    }
}

@Test func aLoneTombstoneIsCheckedBeforeDeletingAndTrashIsADeletion() {
    let batch = ChangeBatch(orgId: org, changes: [
        StorageSyncChange(gone: nil, id: "gone", inTrash: false, node: nil, revision: 1),
        StorageSyncChange(gone: nil, id: "binned", inTrash: true, node: node(id: "binned"), revision: 2),
    ])
    #expect(batch.unresolved == [.node(orgId: org, nodeId: "gone")])
    #expect(batch.deleted == [.node(orgId: org, nodeId: "binned")])
    #expect(batch.updated.isEmpty)
}

@Test func aTombstoneThatSaysGoneDeletesAndOneThatSaysMovedWaitsForItsOtherFeed() {
    let batch = ChangeBatch(orgId: org, changes: [
        StorageSyncChange(gone: true, id: "deleted", inTrash: false, node: nil, revision: 1),
        StorageSyncChange(gone: false, id: "moved", inTrash: false, node: nil, revision: 2),
    ])
    #expect(batch.deleted == [.node(orgId: org, nodeId: "deleted")])
    #expect(batch.unresolved.isEmpty && batch.updated.isEmpty)
}

@Test func aDriveIsSkippedOnlyWhileItsRevisionHasNotMovedSinceItWasReadToTheEnd() {
    let drive = Drive(orgId: "a", space: .personal)
    var anchor = SyncAnchor()
    #expect(!anchor.isCurrent(drive, at: 0))
    anchor.set("c1", for: drive)
    #expect(!anchor.isCurrent(drive, at: 7))
    anchor.set(revision: 7, for: drive)
    #expect(anchor.isCurrent(drive, at: 7))
    #expect(!anchor.isCurrent(drive, at: 8))
    #expect(anchor.keeping([drive]).isCurrent(drive, at: 7))
    #expect(!anchor.keeping([]).isCurrent(drive, at: 7))
}

@Test func aRestoreAfterATrashInOnePageBringsTheItemBack() {
    let batch = ChangeBatch(orgId: org, changes: [
        StorageSyncChange(gone: nil, id: nodeId, inTrash: true, node: node(), revision: 1),
        StorageSyncChange(gone: nil, id: nodeId, inTrash: false, node: node(), revision: 2),
    ])
    #expect(batch.updated.count == 1 && batch.deleted.isEmpty)
}

@Test func refusalsMapToTheErrorTheSystemActsOn() {
    #expect(SyncFailure(status: 401, code: "unauthorized", refreshed: false) == .refreshToken)
    #expect(SyncFailure(status: 401, code: "unauthorized", refreshed: true) == .error(.notAuthenticated))
    #expect(SyncFailure(status: 402, code: "storage_full", refreshed: false) == .error(.insufficientQuota))
    #expect(SyncFailure(status: 404, code: "not_found", refreshed: false) == .error(.noSuchItem))
    #expect(SyncFailure(status: 409, code: "version_conflict", refreshed: false) == .versionConflict)
    #expect(SyncFailure(status: 410, code: "cursor_expired", refreshed: false) == .error(.syncAnchorExpired))
    #expect(SyncFailure(status: 503, code: nil, refreshed: false) == .error(.serverUnreachable))
    // A refusal is never retried as if the network dropped it.
    #expect(SyncFailure(status: 409, code: "locked", refreshed: false) == .error(.cannotSynchronize))
    #expect(SyncFailure(status: 403, code: "forbidden", refreshed: false) == .error(.cannotSynchronize))
}

@Test func systemDroppingsStayLocalButLookalikesUpload() {
    for name in [".DS_Store", "Thumbs.db", "DESKTOP.INI", "~$report.docx", ".~lock.a.odt#", "x.TMP", "._photo.jpg"] {
        #expect(isIgnored(name), "\(name)")
    }
    for name in ["report.docx", "tmp", "notes.tmpl", "_photo.jpg", ".env"] {
        #expect(!isIgnored(name), "\(name)")
    }
}

@Test func aConflictedCopyKeepsItsExtensionSoItOpensInTheSameApp() {
    let date = Date(timeIntervalSince1970: 1_794_787_200) // 2026-11-16T00:00:00Z
    let utc = TimeZone(identifier: "UTC")!
    #expect(conflictedCopyName(of: "plan.pdf", computer: "Mac", date: date, timeZone: utc)
        == "plan (conflicted copy, Mac 2026-11-16).pdf")
    #expect(conflictedCopyName(of: "a.tar.gz", computer: "Mac", date: date, timeZone: utc)
        == "a.tar (conflicted copy, Mac 2026-11-16).gz")
    #expect(conflictedCopyName(of: ".env", computer: "Mac", date: date, timeZone: utc)
        == ".env (conflicted copy, Mac 2026-11-16)")
    #expect(conflictedCopyName(of: "README", computer: "Mac", date: date, timeZone: utc)
        == "README (conflicted copy, Mac 2026-11-16)")
}

@Test func aResumeNeedsTheSameBytesNotJustTheSameSize() {
    let record = UploadRecord(id: "u1", size: 10, sha256: "aaaa", replaces: nodeId)
    #expect(record.resumes(size: 10, sha256: "aaaa", replaces: nodeId))
    // Edited back to the same size: resuming would store a file made of parts of both.
    #expect(!record.resumes(size: 10, sha256: "bbbb", replaces: nodeId))
    // The same bytes saved as a new file are not this version upload, nor the other way round.
    #expect(!record.resumes(size: 10, sha256: "aaaa", replaces: nil))
    #expect(!UploadRecord(id: "u1", size: 10, sha256: "aaaa", replaces: nil).resumes(size: 10, sha256: "aaaa", replaces: nodeId))
    #expect(UploadRecord(record.data) == record)
    // A record written before hashes were kept is the bare upload id: never resumed.
    #expect(UploadRecord(Data("0193a0b2-0000-7000-8000-0000000000ff".utf8)) == nil)
}

@Test func onlyARefusedGrantSignsThePersonOut() {
    let body = { (json: String) in Data(json.utf8) }
    #expect(TokenRefusal(status: 400, body: body(#"{"error":"invalid_grant"}"#)) == .signedOut)
    #expect(TokenRefusal(status: 401, body: body(#"{"error":"invalid_client"}"#)) == .signedOut)
    // A busy or failing token endpoint keeps the grant: sync waits and tries again.
    for status in [408, 429, 500, 502, 503] {
        #expect(TokenRefusal(status: status, body: nil) == .tryLater, "\(status)")
    }
    #expect(TokenRefusal(status: 400, body: body(#"{"error":"invalid_request"}"#)) == .tryLater)
    #expect(TokenRefusal(status: 400, body: body("<html>Bad Gateway</html>")) == .tryLater)
}

// Finder shows these as the files' dates: a slip in the fast path (a leap day, a fraction, the
// turn of a century) would put every synced file at the wrong time.
@Test(arguments: [
    "2026-11-16T10:20:30.123Z", "2024-02-29T23:59:59Z", "2000-03-01T00:00:00.5Z",
    "1999-12-31T23:59:59.999Z", "2100-02-28T12:00:00.000Z", "1970-01-01T00:00:00Z",
    "2026-11-16T10:20:30+01:00",
])
func serverDatesReadWithoutAFormatterMatchFoundation(_ text: String) throws {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let expected = try #require(formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text))
    let read = try #require(WireDate.parse(text))
    #expect(abs(read.timeIntervalSince(expected)) < 0.001)
}

@Test func impossibleDatesAreNotReadAsAnotherDay() {
    #expect(Array("2026-02-30T00:00:00Z".utf8).withUnsafeBufferPointer { WireDate.fast($0) } == nil)
}

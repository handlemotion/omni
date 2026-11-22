// `omni-sync-bench`: runs the File Provider engine's own code against a running Omni server and
// prints what one scenario cost, as one line of JSON: wall time, peak memory (the process's
// lifetime peak physical footprint, the number macOS kills extensions by) and how much it moved.
// One scenario per process, so each peak is its own. See `bench/README.md`.
//
//   omni-sync-bench hash <file>            Uploader.measure: size and sha256
//   omni-sync-bench upload <file>          one file, as createItem sends it
//   omni-sync-bench burst <folder>         every file in a folder at once, as a dropped folder
//   omni-sync-bench walk                   the working set from an empty anchor, to the end
//   omni-sync-bench list                   `My files`' top level, every page
//   omni-sync-bench items <count>          builds and reads <count> items, as Finder does
//
// Environment: OMNI_BENCH_ORIGIN (the server), OMNI_BENCH_TOKEN (a sync access token),
// OMNI_BENCH_ORG (the workspace).

import Darwin
import FileProvider
import Foundation
import OmniSyncClient
import OmniSyncCore
import OmniSyncEngine
@preconcurrency import StorageSync

struct Fail: Error, CustomStringConvertible {
    let description: String
}

func env(_ name: String) throws -> String {
    guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { throw Fail(description: "\(name) is not set") }
    return value
}

/// The token the seed script minted; the bench never refreshes.
struct FixedToken: AccessTokenSource {
    let token: String
    func accessToken() async throws -> String { token }
    func refresh(rejected _: String) async throws -> String { throw TokenError.signedOut }
}

func load() throws -> Sync {
    let origin = try env("OMNI_BENCH_ORIGIN")
    guard let url = URL(string: origin) else { throw Fail(description: "bad origin \(origin)") }
    let settings = SyncSettings(origin: url, workspaces: [try env("OMNI_BENCH_ORG")])
    let identity = SharedIdentity(appGroup: "omni-sync-bench", keychainGroup: "-", keychainService: "-")
    let client = SyncClient(api: settings.api, tokens: FixedToken(token: try env("OMNI_BENCH_TOKEN")))
    return Sync(identity: identity, settings: settings, client: client)
}

/// The process's peak physical footprint so far, in MiB.
func peakMiB() -> Double {
    var info = rusage_info_v4()
    let status = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0) }
    }
    guard status == 0 else { return -1 }
    return Double(info.ri_lifetime_max_phys_footprint) / 1_048_576
}

/// Threads alive now: a part's writer thread that never ended would show here.
func threads() -> Int {
    var list: thread_act_array_t?
    var count: mach_msg_type_number_t = 0
    guard task_threads(mach_task_self_, &list, &count) == KERN_SUCCESS, let list else { return -1 }
    for index in 0..<Int(count) { mach_port_deallocate(mach_task_self_, list[index]) }
    vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: list)), vm_size_t(Int(count) * MemoryLayout<thread_t>.stride))
    return Int(count)
}

/// What fileproviderd reads of every item it is handed.
func inspect(_ item: NSFileProviderItem) -> Int {
    var touched = item.itemIdentifier.rawValue.count + item.parentItemIdentifier.rawValue.count + item.filename.count
    touched += item.contentType?.identifier.count ?? 0
    touched += Int(item.capabilities?.rawValue ?? 0)
    touched += item.itemVersion?.contentVersion.count ?? 0
    touched += item.documentSize??.intValue ?? 0
    touched += Int(item.creationDate??.timeIntervalSince1970 ?? 0)
    touched += Int(item.contentModificationDate??.timeIntervalSince1970 ?? 0)
    return touched
}

/// Collects what an enumerator reports, reading each item as the system would.
final class Changes: NSObject, NSFileProviderChangeObserver, NSFileProviderEnumerationObserver {
    var updated = 0
    var deleted = 0
    var checksum = 0
    private var done: CheckedContinuation<(Data?, Bool), Error>?

    func run(_ start: (Changes) -> Void) async throws -> (Data?, Bool) {
        try await withCheckedThrowingContinuation { continuation in
            done = continuation
            start(self)
        }
    }

    func didUpdate(_ items: [NSFileProviderItemProtocol]) {
        updated += items.count
        for item in items { checksum &+= inspect(item) }
    }

    func didDeleteItems(withIdentifiers ids: [NSFileProviderItemIdentifier]) { deleted += ids.count }

    func didEnumerate(_ items: [NSFileProviderItemProtocol]) { didUpdate(items) }

    func finishEnumeratingChanges(upTo anchor: NSFileProviderSyncAnchor, moreComing: Bool) {
        done?.resume(returning: (anchor.rawValue, moreComing))
        done = nil
    }

    func finishEnumerating(upTo page: NSFileProviderPage?) {
        done?.resume(returning: (page?.rawValue, page != nil))
        done = nil
    }

    func finishEnumeratingWithError(_ error: Error) {
        done?.resume(throwing: error)
        done = nil
    }
}

func walk() async throws -> [String: Any] {
    let enumerator = WorkingSetEnumerator(load: load)
    let observer = Changes()
    var anchor = NSFileProviderSyncAnchor(Data("{}".utf8))
    var calls = 0
    var more = true
    while more {
        let (next, moreComing) = try await observer.run { enumerator.enumerateChanges(for: $0, from: anchor) }
        anchor = NSFileProviderSyncAnchor(next ?? Data())
        more = moreComing
        calls += 1
    }
    return ["items": observer.updated, "deleted": observer.deleted, "calls": calls]
}

func list() async throws -> [String: Any] {
    let org = try env("OMNI_BENCH_ORG")
    let enumerator = FolderEnumerator(container: .space(orgId: org, space: .personal), load: load)
    let observer = Changes()
    var page = NSFileProviderPage.initialPageSortedByName as NSFileProviderPage
    var calls = 0
    var more = true
    while more {
        let (next, moreComing) = try await observer.run { enumerator.enumerateItems(for: $0, startingAt: page) }
        if let next { page = NSFileProviderPage(next) }
        more = moreComing
        calls += 1
    }
    return ["items": observer.updated, "calls": calls]
}

func items(_ count: Int) -> [String: Any] {
    var checksum = 0
    for index in 0..<count {
        let node = StorageNode(
            contentSha256: nil, contentVersion: 1, createdAt: "2026-11-16T10:20:30.123Z", createdByMemberId: nil,
            id: "n\(index)", kind: .file, lockedAt: nil, mimeType: "application/pdf", name: "Report \(index).pdf",
            orgId: "org", ownerMemberId: nil, parentId: nil, revision: index, size: index, space: .personal,
            teamOnly: nil, teamspaceId: nil, trashedAt: nil, updatedAt: "2026-11-17T10:20:30.123Z"
        )
        checksum &+= inspect(Item(node: node))
    }
    return ["items": count, "checksum": checksum]
}

func upload(_ file: URL, sync: Sync, name: String) async throws -> Int {
    let org = sync.settings.workspaces[0]
    let bytes = try await Uploader.measure(file)
    let node = try await Uploader(sync: sync, orgId: org, key: "bench-\(UUID().uuidString)").send(bytes, open: { size, sha256 in
        let body = StorageOpenUploadBody(mimeType: nil, name: name, parentId: nil, sha256: sha256, size: size, space: .personal, teamspaceId: nil)
        return try await sync.client.openUpload(orgId: org, body)
    }, progress: Progress(totalUnitCount: 1))
    return node.size
}

/// Every file in `folder` at once, the way fileproviderd hands a dropped folder over: it does not
/// wait for one createItem before it calls the next.
func burst(_ folder: URL) async throws -> [String: Any] {
    let sync = try load()
    let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        .filter { !$0.lastPathComponent.hasPrefix(".") }
    let run = UUID().uuidString.prefix(6)
    let sent = try await withThrowingTaskGroup(of: Int.self) { group in
        for file in files {
            group.addTask { try await upload(file, sync: sync, name: "\(run)-\(file.lastPathComponent)") }
        }
        return try await group.reduce(0, +)
    }
    return ["files": files.count, "bytes": sent]
}

let arguments = Array(CommandLine.arguments.dropFirst())
let started = Date()
do {
    guard let scenario = arguments.first else { throw Fail(description: "usage: omni-sync-bench hash|upload|burst|walk|list|items …") }
    var result: [String: Any]
    switch scenario {
    case "hash":
        let bytes = try await Uploader.measure(URL(fileURLWithPath: arguments[1]))
        result = ["bytes": bytes.size]
    case "upload":
        let file = URL(fileURLWithPath: arguments[1])
        result = ["bytes": try await upload(file, sync: try load(), name: "bench-\(UUID().uuidString.prefix(6))-\(file.lastPathComponent)")]
    case "burst": result = try await burst(URL(fileURLWithPath: arguments[1]))
    case "walk": result = try await walk()
    case "list": result = try await list()
    case "items": result = items(Int(arguments[1]) ?? 10000)
    default: throw Fail(description: "unknown scenario \(scenario)")
    }
    let seconds = Date().timeIntervalSince(started)
    result["scenario"] = scenario
    result["seconds"] = (seconds * 100).rounded() / 100
    result["peakMiB"] = (peakMiB() * 10).rounded() / 10
    // A part's writer thread ends once its request is over; give the last ones a moment.
    try? await Task.sleep(nanoseconds: 300_000_000)
    result["threads"] = threads()
    if let bytes = result["bytes"] as? Int, seconds > 0 { result["MiBps"] = (Double(bytes) / 1_048_576 / seconds * 10).rounded() / 10 }
    let line = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(line + Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("omni-sync-bench: \(error)\n".utf8))
    exit(1)
}

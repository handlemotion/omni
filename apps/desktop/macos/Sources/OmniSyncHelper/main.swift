// `omni-sync`: the app's side of Drive sync on macOS (ADR 0043, amended). The Tauri shell runs it
// from `Contents/MacOS/` for each sync command and reads one line of JSON back. It registers and
// removes the File Provider domain, keeps the sync token in the keychain group the extension
// reads, writes `sync.json`, and signals the working set. Rust stays free of `unsafe`, and the
// keychain and settings code exists once, shared with the extension.
//
//   omni-sync status                       DesktopSyncStatus
//   omni-sync sign-in <origin>             { "url": … } to open in the app window
//   omni-sync finish-sign-in <callback>    { "ok": true } once the tokens are stored
//   omni-sync connect <orgId>              DesktopWorkspaceSync
//   omni-sync disconnect <orgId>           DesktopWorkspaceSync
//   omni-sync signal                       { "ok": true }: something changed on the server
//   omni-sync pause | resume               { "ok": true }
//   omni-sync sign-out                     { "ok": true }: domain, token and settings gone
//
// A failure exits 1 with one line on stderr.

import FileProvider
import Foundation
import OmniSyncClient
import StorageSync

/// The one domain: "Omni" in Finder's sidebar, a folder per synced workspace inside.
enum Omni {
    static var domain: NSFileProviderDomain {
        NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier("omni"), displayName: "Omni")
    }
}

/// The extension's Info.plist is the one place the shared identity is written down.
func identity() throws -> (SharedIdentity, URL) {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let appex = executable.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("PlugIns/OmniFileProvider.appex")
    guard let bundle = Bundle(url: appex), let identity = SharedIdentity(bundle: bundle),
          let container = identity.container
    else { throw Failure("the File Provider extension is not in this app") }
    try? FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    return (identity, container)
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func print<T: Encodable>(json value: T) throws {
    FileHandle.standardOutput.write(try JSONEncoder().encode(value) + Data("\n".utf8))
}

func manager() throws -> NSFileProviderManager {
    guard let manager = NSFileProviderManager(for: Omni.domain) else { throw Failure("the Omni domain is not registered") }
    return manager
}

func registered() async throws -> Bool {
    try await NSFileProviderManager.domains().contains { $0.identifier == Omni.domain.identifier }
}

func signal() async throws {
    guard try await registered() else { return }
    try await manager().signalEnumerator(for: .workingSet)
    try await manager().signalEnumerator(for: .rootContainer)
}

/// Where sync stands for one workspace. Nothing here asks the server: the extension's errors
/// reach Finder, and a missing token is the one thing the app must act on.
func state(of orgId: String, settings: SyncSettings?, tokens: TokenStore) -> DesktopSyncState {
    guard let settings, settings.workspaces.contains(orgId) else { return .off }
    if (try? tokens.read()) == nil { return .needsAttention }
    return settings.paused ? .paused : .synced
}

func run(_ arguments: [String]) async throws {
    let (identity, container) = try identity()
    let settings = SyncSettings.read(from: container)
    let tokens = TokenStore(identity: identity, settings: { SyncSettings.read(from: container) })
    switch (arguments.first, arguments.count) {
    case ("status", 1):
        let workspaces = (settings?.workspaces ?? []).map {
            DesktopWorkspaceSync(orgId: $0, state: state(of: $0, settings: settings, tokens: tokens))
        }
        try print(json: DesktopSyncStatus(available: true, workspaces: workspaces))

    case ("sign-in", 2):
        guard let origin = URL(string: arguments[1]), origin.scheme?.hasPrefix("http") == true else {
            throw Failure("not a server origin: \(arguments[1])")
        }
        let (_, url) = try SignIn.begin(origin: origin, container: container)
        try print(json: DesktopSyncSignIn(url: url.absoluteString))

    case ("finish-sign-in", 2):
        guard let callback = URL(string: arguments[1]) else { throw Failure("not a callback URL") }
        let (signIn, fresh) = try await SignIn.finish(callback: callback, container: container)
        try tokens.write(fresh)
        var next = settings ?? SyncSettings(origin: signIn.origin, workspaces: [])
        next.origin = signIn.origin
        try next.write(to: container)
        try await signal()
        try print(json: DesktopSyncDone(ok: true))

    case ("connect", 2):
        let orgId = arguments[1]
        guard var next = settings, (try? tokens.read()) != nil else {
            try print(json: DesktopWorkspaceSync(orgId: orgId, state: .needsAttention))
            return
        }
        if !next.workspaces.contains(orgId) { next.workspaces.append(orgId) }
        try next.write(to: container)
        if try await !registered() { try await NSFileProviderManager.add(Omni.domain) }
        try await signal()
        try print(json: DesktopWorkspaceSync(orgId: orgId, state: state(of: orgId, settings: next, tokens: tokens)))

    case ("disconnect", 2):
        let orgId = arguments[1]
        if var next = settings {
            next.workspaces.removeAll { $0 == orgId }
            try next.write(to: container)
            // Its folder leaves this computer; nothing leaves the server.
            try await signal()
        }
        try print(json: DesktopWorkspaceSync(orgId: orgId, state: .off))

    case ("signal", 1):
        try await signal()
        try print(json: DesktopSyncDone(ok: true))

    case ("pause", 1), ("resume", 1):
        guard var next = settings else { throw Failure("sync is not set up") }
        next.paused = arguments[0] == "pause"
        try next.write(to: container)
        try await signal()
        try print(json: DesktopSyncDone(ok: true))

    case ("sign-out", 1):
        if try await registered() {
            // Files not uploaded yet are kept, and moved where the person will find them.
            if let kept = try await NSFileProviderManager.remove(Omni.domain, mode: .preserveDirtyUserData) {
                try keep(kept)
            }
        }
        try tokens.delete()
        try? FileManager.default.removeItem(at: container.appendingPathComponent(SyncSettings.fileName))
        try print(json: DesktopSyncDone(ok: true))

    default:
        throw Failure("usage: omni-sync status|sign-in <origin>|finish-sign-in <url>|connect <orgId>|disconnect <orgId>|signal|pause|resume|sign-out")
    }
}

/// `Not uploaded` on the Desktop, numbered if one is already there.
func keep(_ preserved: URL) throws {
    let desktop = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
    var target = desktop.appendingPathComponent("Not uploaded")
    var n = 2
    while FileManager.default.fileExists(atPath: target.path) {
        target = desktop.appendingPathComponent("Not uploaded \(n)")
        n += 1
    }
    try FileManager.default.moveItem(at: preserved, to: target)
}

do {
    try await run(Array(CommandLine.arguments.dropFirst()))
} catch {
    FileHandle.standardError.write(Data("omni-sync: \(error)\n".utf8))
    exit(1)
}

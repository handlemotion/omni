// swift-tools-version: 6.0
// The File Provider extension's Swift code that needs no extension to run (docs/spec/desktop.md "The File Provider extension"): the wire types generated from
// @omni/contracts, and the pure rules the extension applies to them. The Xcode project that
// builds OmniFileProvider.appex links these; `swift test` checks them on any Mac.

import PackageDescription

let package = Package(
    name: "OmniSync",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "OmniSyncCore", targets: ["OmniSyncCore"]),
        .library(name: "OmniSyncClient", targets: ["OmniSyncClient"]),
    ],
    targets: [
        // Symlinked from `apps/desktop/generated/swift`: generator output, never edited here.
        .target(name: "StorageSync", swiftSettings: [.swiftLanguageMode(.v5)]),
        .target(name: "OmniSyncCore", dependencies: ["StorageSync"]),
        // The sync API over URLSession, the token in the keychain, the settings the app shares.
        .target(name: "OmniSyncClient", dependencies: ["OmniSyncCore", "StorageSync"]),
        // What the extension does for each call, without the extension: items, enumeration,
        // uploads. A library so `omni-sync-bench` runs the very same code.
        .target(
            name: "OmniSyncEngine",
            dependencies: ["OmniSyncClient", "OmniSyncCore", "StorageSync"],
            // FileProvider's observers and completion handlers carry no Sendable annotations.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // OmniFileProvider.appex's executable; `scripts/build-extension.sh` wraps it in the bundle.
        .executableTarget(
            name: "OmniFileProvider",
            dependencies: ["OmniSyncClient", "OmniSyncCore", "OmniSyncEngine", "StorageSync"],
            // FileProvider's observers and completion handlers carry no Sendable annotations.
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"])]
        ),
        // `omni-sync`, the app's side: domain, token, settings, signals. Run by the Tauri shell.
        .executableTarget(
            name: "OmniSyncHelper",
            dependencies: ["OmniSyncClient", "StorageSync"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // `omni-sync-bench`: memory and time of the engine against a running server
        // (`bench/README.md`). Never shipped.
        .executableTarget(
            name: "OmniSyncBench",
            dependencies: ["OmniSyncClient", "OmniSyncCore", "OmniSyncEngine", "StorageSync"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(name: "OmniSyncCoreTests", dependencies: ["OmniSyncCore", "StorageSync"]),
    ]
)

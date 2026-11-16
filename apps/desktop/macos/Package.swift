// swift-tools-version: 6.0
// The File Provider extension's Swift code that needs no extension to run (ADR 0043,
// docs/spec/desktop.md "The File Provider extension"): the wire types generated from
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
        // OmniFileProvider.appex's executable; `scripts/build-extension.sh` wraps it in the bundle.
        .executableTarget(
            name: "OmniFileProvider",
            dependencies: ["OmniSyncClient", "OmniSyncCore", "StorageSync"],
            // FileProvider's observers and completion handlers carry no Sendable annotations.
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"])]
        ),
        .testTarget(name: "OmniSyncCoreTests", dependencies: ["OmniSyncCore", "StorageSync"]),
    ]
)

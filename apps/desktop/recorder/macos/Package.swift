// swift-tools-version: 6.0
// `omni-capture`: the macOS half of the meeting recorder's capture (docs/spec/meetings.md,
// "Capture"). The Rust recorder runs it from Contents/MacOS and reads its stdout
// (`recorder/src/capture/pipe.rs`). `scripts/build.sh` builds and signs it.

import PackageDescription

let package = Package(
    name: "OmniCapture",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "OmniCapture",
            // Core Audio's callbacks and ScreenCaptureKit's delegates carry no Sendable annotations.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)

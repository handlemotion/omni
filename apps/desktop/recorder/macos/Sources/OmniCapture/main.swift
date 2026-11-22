// omni-capture: this Mac's microphone and sound, as mono 48 kHz float, on stdout.
//
// Protocol (recorder/src/capture/pipe.rs): one "R" byte once both streams run, then chunks of a
// tag byte ("M" mic, "S" the computer's sound), a little-endian UInt32 sample count and the
// samples as little-endian Float32. The Rust recorder stops it by killing it.
//
// - The microphone through AVAudioEngine with voice processing on (echo cancellation), and
//   other apps' audio not ducked, so the call sounds as it did.
// - The computer's sound through a Core Audio process tap on every process (macOS 14.4+, asks
//   for audio capture permission), else ScreenCaptureKit with audio only (13 to 14.3, asks for
//   screen recording).
//
// Exit codes: 2, microphone permission refused; 3, sound capture permission refused; 1, any
// other failure, with the reason on stderr.

import AVFoundation
import CoreAudio
import Foundation
import ScreenCaptureKit

let rate = 48_000.0

/// Writes chunks to stdout, one at a time, from any thread. Nothing goes out before the ready
/// byte: the mic starts before the computer's sound, and the recorder reads the first byte as
/// "both streams run" (a chunk there would read as a failed start).
final class Output {
    private let lock = NSLock()
    private let out = FileHandle.standardOutput
    private var isReady = false

    func ready() {
        lock.lock()
        defer { lock.unlock() }
        write(Data([UInt8(ascii: "R")]))
        isReady = true
    }

    func send(_ tag: Character, _ samples: [Float]) {
        guard !samples.isEmpty else { return }
        var data = Data(capacity: 5 + samples.count * 4)
        data.append(tag.asciiValue ?? 0)
        var count = UInt32(samples.count).littleEndian
        withUnsafeBytes(of: &count) { data.append(contentsOf: $0) }
        // Float32 is little-endian on both Mac architectures (arm64, x86_64).
        samples.withUnsafeBytes { data.append(contentsOf: $0) }
        lock.lock()
        defer { lock.unlock() }
        guard isReady else { return }
        write(data)
    }

    /// Called with the lock held.
    private func write(_ data: Data) {
        do {
            try out.write(contentsOf: data)
        } catch {
            // The recorder went away: nothing left to capture for.
            exit(0)
        }
    }
}

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

/// Converts any PCM buffer to mono Float32 at 48 kHz.
final class Mono48k {
    private let target = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var source: AVAudioFormat?

    func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
        if source != buffer.format {
            source = buffer.format
            converter = AVAudioConverter(from: buffer.format, to: target)
            converter?.downmix = true
        }
        guard let converter else { return [] }
        let capacity = AVAudioFrameCount(
            Double(buffer.frameLength) * rate / buffer.format.sampleRate) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
        var given = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.floatChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
    }
}

// MARK: - Microphone

final class Microphone {
    private let engine = AVAudioEngine()
    private let mono = Mono48k()

    func start(_ output: Output) throws {
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        if #available(macOS 14.0, *) {
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
                    enableAdvancedDucking: false, duckingLevel: .min)
        }
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 960, format: format) { [mono] buffer, _ in
            output.send("M", mono.convert(buffer))
        }
        try engine.start()
    }
}

func microphoneAllowed() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined:
        let answered = DispatchSemaphore(value: 0)
        var allowed = false
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            allowed = granted
            answered.signal()
        }
        answered.wait()
        return allowed
    default: return false
    }
}

// MARK: - The computer's sound, macOS 14.4+: a process tap

struct CoreAudioError: Error, CustomStringConvertible {
    let what: String
    let status: OSStatus
    var description: String { "\(what) failed (\(status))" }
}

func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr { throw CoreAudioError(what: what, status: status) }
}

func defaultOutputUID() throws -> String {
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    try check(
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device),
        "reading the default output")
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    address.mSelector = kAudioDevicePropertyDeviceUID
    try check(AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid), "reading its UID")
    guard let uid else { throw CoreAudioError(what: "reading its UID", status: -1) }
    return uid.takeRetainedValue() as String
}

@available(macOS 14.4, *)
final class ProcessTap {
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var proc: AudioDeviceIOProcID?
    private let mono = Mono48k()
    private let queue = DispatchQueue(label: "omni-capture.tap", qos: .userInitiated)

    func start(_ output: Output) throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.muteBehavior = .unmuted
        description.isPrivate = true
        try check(AudioHardwareCreateProcessTap(description, &tap), "creating the process tap")

        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format), "reading the tap's format")
        guard let tapFormat = AVAudioFormat(streamDescription: &format) else {
            throw CoreAudioError(what: "reading the tap's format", status: -1)
        }

        let outputUID = try defaultOutputUID()
        let settings: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Omni Recorder",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapDriftCompensationKey: true,
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                ]
            ],
        ]
        try check(
            AudioHardwareCreateAggregateDevice(settings as CFDictionary, &aggregate),
            "creating the aggregate device")
        try check(
            AudioDeviceCreateIOProcIDWithBlock(&proc, aggregate, queue) { [mono] _, input, _, _, _ in
                guard
                    let buffer = AVAudioPCMBuffer(
                        pcmFormat: tapFormat, bufferListNoCopy: input, deallocator: nil)
                else { return }
                output.send("S", mono.convert(buffer))
            },
            "listening to the tap")
        try check(AudioDeviceStart(aggregate, proc), "starting the tap")
    }
}

// MARK: - The computer's sound, macOS 13 to 14.3: ScreenCaptureKit, audio only

final class ScreenAudio: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let mono = Mono48k()
    private let output: Output
    private let queue = DispatchQueue(label: "omni-capture.sck", qos: .userInitiated)

    init(_ output: Output) {
        self.output = output
    }

    /// Returns once capture has started, or throws why it could not: `startCapture` reports
    /// asynchronously, so this waits for its answer before the helper says it is ready.
    func start() throws {
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            guard let display = content?.displays.first else {
                failure = error ?? CoreAudioError(what: "finding a display", status: -1)
                done.signal()
                return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.capturesAudio = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate = Int(rate)
            config.channelCount = 1
            // Video is required; the smallest, slowest one costs next to nothing.
            config.width = 2
            config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            do {
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue)
            } catch {
                failure = error
                done.signal()
                return
            }
            self.stream = stream
            stream.startCapture { error in
                failure = error
                done.signal()
            }
        }
        done.wait()
        if let failure { throw failure }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio,
            let description = sample.formatDescription?.audioStreamBasicDescription,
            var asbd = Optional(description),
            let format = AVAudioFormat(streamDescription: &asbd)
        else { return }
        let frames = AVAudioFrameCount(sample.numSamples)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return }
        buffer.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sample, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
        guard status == noErr else { return }
        output.send("S", mono.convert(buffer))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail(1, "screen capture stopped: \(error.localizedDescription)")
    }
}

// MARK: - Main

let output = Output()
signal(SIGPIPE, SIG_IGN)

guard microphoneAllowed() else { fail(2, "microphone permission refused") }
let microphone = Microphone()
do {
    try microphone.start(output)
} catch {
    fail(1, "the microphone could not start: \(error)")
}

var keep: [AnyObject] = [microphone]
if #available(macOS 14.4, *) {
    let tap = ProcessTap()
    do {
        try tap.start(output)
    } catch {
        fail(3, "this Mac's sound could not be captured: \(error)")
    }
    keep.append(tap)
} else {
    let screen = ScreenAudio(output)
    do {
        try screen.start()
    } catch {
        // SCStreamError.userDeclined, or no screen recording permission.
        fail(3, "this Mac's sound could not be captured: \(error.localizedDescription)")
    }
    keep.append(screen)
}

output.ready()
withExtendedLifetime(keep) { RunLoop.main.run() }

// omni-capture: this Mac's microphone and sound, as mono 48 kHz float, and the screen the person
// picks, as H.264 in fragmented MP4, on stdout.
//
// Protocol (recorder/src/capture/pipe.rs): one "R" byte once both sound streams run, then chunks
// of a tag byte ("M" mic, "S" the computer's sound), a little-endian UInt32 sample count and the
// samples as little-endian Float32; or "V", a little-endian UInt32 byte count and that many bytes
// of the video (its first chunk the MP4's header, then whole fragments, in order).
//
// stdin: "P" pauses the video, "R" resumes it; its end stops: the video's last fragment goes out,
// then the helper exits. The recorder kills it if that takes too long.
//
// - The microphone through AVAudioEngine, as it is: voice processing (echo cancellation) silences
//   both the mic and the process tap, so the call's own sound is told apart by the right channel.
// - The screen (macOS 14+) through ScreenCaptureKit, from the system's content-sharing picker shown
//   once the sound runs; Cancel records sound only. Its clock starts at the ready byte, the
//   audio's zero, and leaves paused time out as the audio does.
// - The computer's sound through a Core Audio process tap on every process (macOS 14.4+, asks
//   for audio capture permission), else ScreenCaptureKit with audio only (13 to 14.3, asks for
//   screen recording).
//
// Exit codes: 2, microphone permission refused; 3, sound capture permission refused; 1, any
// other failure, with the reason on stderr.

import AVFoundation
import AppKit
import CoreAudio
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

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
        // Float32 is little-endian on both Mac architectures (arm64, x86_64).
        samples.withUnsafeBytes { send(tag, count: samples.count, Data($0)) }
    }

    /// Video bytes: their count, then the bytes.
    func send(video bytes: Data) {
        guard !bytes.isEmpty else { return }
        send("V", count: bytes.count, bytes)
    }

    private func send(_ tag: Character, count: Int, _ payload: Data) {
        var data = Data(capacity: 5 + payload.count)
        data.append(tag.asciiValue ?? 0)
        var count = UInt32(count).littleEndian
        withUnsafeBytes(of: &count) { data.append(contentsOf: $0) }
        data.append(payload)
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
        // WARNING: no voice processing. With it on, macOS hands back silence on the mic and on the process tap.
        let input = engine.inputNode
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
            kAudioAggregateDeviceNameKey: "Wok Recorder",
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

// MARK: - The screen, macOS 14+: the picker, ScreenCaptureKit, H.264 in fragmented MP4

/// The host clock, which ScreenCaptureKit stamps frames with.
func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

@available(macOS 14.0, *)
final class Screen: NSObject, SCContentSharingPickerObserver, SCStreamOutput, SCStreamDelegate,
    AVAssetWriterDelegate
{
    static let longSide = 1920.0
    static let fps: Int32 = 15
    static let bitRate = 1_000_000
    /// A key frame and a fragment every this many seconds: what a crash can lose.
    static let fragment = 2.0

    private let output: Output
    /// The audio's zero: frames are stamped from it.
    private let zero: CMTime
    private let queue = DispatchQueue(label: "omni-capture.screen", qos: .userInitiated)
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var last = CMTime.invalid
    private var pausedAt: CMTime?
    private var pausedFor = CMTime.zero
    private var finishing = false

    init(_ output: Output, zero: CMTime) {
        self.output = output
        self.zero = zero
    }

    func pick() {
        DispatchQueue.main.async {
            let picker = SCContentSharingPicker.shared
            var config = SCContentSharingPickerConfiguration()
            config.allowedPickerModes = [.singleWindow, .singleDisplay]
            config.allowsChangingSelectedContent = true
            picker.defaultConfiguration = config
            picker.add(self)
            picker.isActive = true
            picker.present()
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        queue.async { [self] in
            if let stream = self.stream {
                stream.updateContentFilter(filter) { _ in }
                return
            }
            guard !finishing else { return }
            start(filter)
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        queue.async { [self] in
            if self.stream == nil { picker.isActive = false }
        }
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        FileHandle.standardError.write(Data("the screen picker failed: \(error)\n".utf8))
    }

    /// Called on `queue`.
    private func start(_ filter: SCContentFilter) {
        let scale = Double(filter.pointPixelScale)
        var width = Double(filter.contentRect.width) * scale
        var height = Double(filter.contentRect.height) * scale
        let fit = min(1, Self.longSide / max(width, height, 1))
        // H.264 wants even sides.
        width = max(2, (width * fit / 2).rounded() * 2)
        height = max(2, (height * fit / 2).rounded() * 2)

        let config = SCStreamConfiguration()
        config.width = Int(width)
        config.height = Int(height)
        config.minimumFrameInterval = CMTime(value: 1, timescale: Self.fps)
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.scalesToFit = true
        config.preservesAspectRatio = true
        config.showsCursor = true
        config.queueDepth = 6

        let writer = AVAssetWriter(contentType: UTType(AVFileType.mp4.rawValue)!)
        writer.outputFileTypeProfile = .mpeg4AppleHLS
        writer.preferredOutputSegmentInterval = CMTime(seconds: Self.fragment, preferredTimescale: 600)
        writer.initialSegmentStartTime = .zero
        writer.delegate = self
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: config.width,
                AVVideoHeightKey: config.height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: Self.bitRate,
                    AVVideoMaxKeyFrameIntervalDurationKey: Self.fragment,
                    AVVideoAllowFrameReorderingKey: false,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ],
            ])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.startWriting() else {
            FileHandle.standardError.write(Data("the video could not start: \(String(describing: writer.error))\n".utf8))
            return
        }
        writer.startSession(atSourceTime: .zero)
        self.writer = writer
        self.adaptor = adaptor

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        } catch {
            FileHandle.standardError.write(Data("the screen could not be captured: \(error)\n".utf8))
            return
        }
        self.stream = stream
        stream.startCapture { error in
            if let error {
                FileHandle.standardError.write(Data("the screen could not be captured: \(error)\n".utf8))
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, !finishing, pausedAt == nil, sample.isValid,
            let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
            let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
            let pixels = sample.imageBuffer,
            let adaptor, adaptor.assetWriterInput.isReadyForMoreMediaData
        else { return }
        // The first frame is held from the audio's zero, so a slow pick shifts nothing after it.
        var at = CMTimeSubtract(CMTimeSubtract(sample.presentationTimeStamp, zero), pausedFor)
        if !last.isValid {
            at = .zero
        } else if at <= last {
            return
        }
        if adaptor.append(pixels, withPresentationTime: at) { last = at }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // The window closed or permission went: the video ends there, the sound goes on.
        FileHandle.standardError.write(Data("screen capture stopped: \(error.localizedDescription)\n".utf8))
    }

    func assetWriter(
        _ writer: AVAssetWriter, didOutputSegmentData segmentData: Data,
        segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?
    ) {
        output.send(video: segmentData)
    }

    func pause() {
        queue.async { [self] in
            if pausedAt == nil { pausedAt = hostNow() }
        }
    }

    func resume() {
        queue.async { [self] in
            guard let since = pausedAt else { return }
            pausedFor = CMTimeAdd(pausedFor, CMTimeSubtract(hostNow(), since))
            pausedAt = nil
        }
    }

    /// Writes the last fragment out, then calls `done`.
    func finish(_ done: @escaping () -> Void) {
        queue.async { [self] in
            finishing = true
            stream?.stopCapture { _ in }
            DispatchQueue.main.async { SCContentSharingPicker.shared.isActive = false }
            guard let writer, writer.status == .writing, last.isValid else { return done() }
            adaptor?.assetWriterInput.markAsFinished()
            writer.finishWriting { done() }
        }
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

var screen: AnyObject?
if #available(macOS 14.0, *) {
    let picked = Screen(output, zero: hostNow())
    picked.pick()
    screen = picked
}

/// Pause, resume, and the end of stdin to stop, from the recorder.
Thread.detachNewThread {
    let input = FileHandle.standardInput
    while true {
        let byte = input.readData(ofLength: 1)
        guard let command = byte.first else { break }
        guard #available(macOS 14.0, *), let screen = screen as? Screen else { continue }
        if command == UInt8(ascii: "P") { screen.pause() }
        if command == UInt8(ascii: "R") { screen.resume() }
    }
    guard #available(macOS 14.0, *), let screen = screen as? Screen else { exit(0) }
    screen.finish { exit(0) }
}

NSApplication.shared.setActivationPolicy(.accessory)
withExtendedLifetime((keep, screen)) { NSApplication.shared.run() }

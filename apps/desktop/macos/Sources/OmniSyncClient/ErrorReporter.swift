import Foundation

/// Sends the File Provider's unexpected sync failures to Sentry when the build sets
/// `OmniSentryDSN` in the extension's Info.plist (`OMNI_DESKTOP_SENTRY_DSN`). No SDK: one small
/// HTTPS POST per event, so the extension stays light. An event carries the error's type, HTTP
/// status and code, never a file name or a path. At most 20 events per process, and the same
/// failure once, so an outage can't spend the shared free quota.
public final class ErrorReporter: @unchecked Sendable {
    public static let shared = ErrorReporter(bundle: .main)

    private let endpoint: URL?
    private let key: String
    private let release: String
    private let lock = NSLock()
    private var sent = Set<String>()
    private let limit = 20

    init(bundle: Bundle) {
        let dsn = (bundle.object(forInfoDictionaryKey: "OmniSentryDSN") as? String).flatMap(URL.init(string:))
        release = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        guard let dsn, let host = dsn.host, let key = dsn.user, let project = dsn.pathComponents.last, !project.isEmpty, project != "/" else {
            endpoint = nil
            self.key = ""
            return
        }
        self.key = key
        var parts = URLComponents()
        parts.scheme = dsn.scheme ?? "https"
        parts.host = host
        parts.port = dsn.port
        let prefix = dsn.pathComponents.dropFirst().dropLast().joined(separator: "/")
        parts.path = (prefix.isEmpty ? "" : "/\(prefix)") + "/api/\(project)/envelope/"
        endpoint = parts.url
    }

    /// Reports `summary` (a type name, a status and code) for a Drive sync `stage`, once.
    public func report(stage: String, summary: String) {
        guard let endpoint else { return }
        let fingerprint = "\(stage) \(summary)"
        lock.lock()
        let fresh = sent.count < limit && sent.insert(fingerprint).inserted
        lock.unlock()
        guard fresh else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-sentry-envelope", forHTTPHeaderField: "Content-Type")
        request.setValue("Sentry sentry_version=7, sentry_key=\(key), sentry_client=omni-macos/1", forHTTPHeaderField: "X-Sentry-Auth")
        request.httpBody = envelope(stage: stage, summary: summary)
        URLSession.shared.dataTask(with: request).resume()
    }

    private func envelope(stage: String, summary: String) -> Data {
        let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let now = ISO8601DateFormatter().string(from: Date())
        let event: [String: Any] = [
            "event_id": id,
            "timestamp": now,
            "platform": "cocoa",
            "level": "error",
            "logger": "file-provider",
            "release": "omni-desktop@\(release)",
            "environment": "production",
            "tags": ["area": "drive", "drive_stage": stage],
            "exception": ["values": [["type": "SyncFailure", "value": summary]]],
            "fingerprint": [stage, summary],
        ]
        let lines: [[String: Any]] = [["event_id": id, "sent_at": now], ["type": "event"], event]
        let encoded = lines.compactMap { try? JSONSerialization.data(withJSONObject: $0) }
        return Data(encoded.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n").utf8)
    }
}

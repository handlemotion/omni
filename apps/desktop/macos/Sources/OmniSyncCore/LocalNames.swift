import Foundation

/// Files the provider never uploads: operating-system and editor droppings
/// (docs/spec/desktop.md "What the provider ignores"). Compared without case, as both systems
/// that write them do.
public func isIgnored(_ name: String) -> Bool {
    let lower = name.lowercased()
    if [".ds_store", "thumbs.db", "desktop.ini"].contains(lower) { return true }
    if lower.hasPrefix("~$") || lower.hasPrefix(".~lock.") || lower.hasPrefix("._") { return true }
    return lower.hasSuffix(".tmp")
}

/// The name a local edit is uploaded under when the server's file changed since it was read:
/// `name (conflicted copy, <computer> <date>).ext`, beside the original. The extension is the
/// last one, so the copy still opens in the same app; a dotfile has none.
public func conflictedCopyName(
    of name: String,
    computer: String,
    date: Date,
    timeZone: TimeZone = .current
) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let day = calendar.dateComponents([.year, .month, .day], from: date)
    let stamp = String(format: "%04d-%02d-%02d", day.year ?? 0, day.month ?? 0, day.day ?? 0)
    let tag = " (conflicted copy, \(computer) \(stamp))"
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return name + tag }
    return name[..<dot] + tag + name[dot...]
}

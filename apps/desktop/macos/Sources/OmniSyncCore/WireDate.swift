import Foundation

/// The server's timestamps, as JavaScript's `toISOString` writes them
/// (`2026-11-16T10:20:30.123Z`), read straight from their bytes. Finder asks every item for two
/// dates, and building a formatter for each read was most of the time a large folder took to
/// list. Anything in another shape goes to Foundation's ISO 8601 parser.
public enum WireDate {
    public static func parse(_ text: String) -> Date? {
        var text = text
        if let date = text.withUTF8({ fast($0) }) { return date }
        return withFraction.date(from: text) ?? plain.date(from: text)
    }

    // ISO8601DateFormatter is thread safe; one of each serves every call.
    private nonisolated(unsafe) static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private nonisolated(unsafe) static let plain = ISO8601DateFormatter()

    /// `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, UTC; nil for anything else.
    static func fast(_ b: UnsafeBufferPointer<UInt8>) -> Date? {
        guard b.count >= 20, b[4] == 0x2D, b[7] == 0x2D, b[10] == 0x54, b[13] == 0x3A, b[16] == 0x3A,
              b[b.count - 1] == 0x5A
        else { return nil }
        func number(_ from: Int, _ count: Int) -> Int? {
            var value = 0
            for index in from..<(from + count) {
                let digit = Int(b[index]) - 0x30
                guard (0...9).contains(digit) else { return nil }
                value = value * 10 + digit
            }
            return value
        }
        guard let year = number(0, 4), let month = number(5, 2), let day = number(8, 2),
              let hour = number(11, 2), let minute = number(14, 2), let second = number(17, 2),
              (1...12).contains(month), day >= 1, day <= daysIn(month: month, year: year),
              hour < 24, minute < 60, second < 60
        else { return nil }
        var fraction = 0.0
        if b.count > 20 {
            // `.` and at least one digit before the `Z`.
            guard b[19] == 0x2E, b.count > 21, b.count <= 30, let digits = number(20, b.count - 21) else { return nil }
            fraction = Double(digits) / pow(10, Double(b.count - 21))
        } else if b[19] != 0x5A {
            return nil
        }
        let seconds = days(year: year, month: month, day: day) * 86400 + hour * 3600 + minute * 60 + second
        return Date(timeIntervalSince1970: Double(seconds) + fraction)
    }

    private static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 2: return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
    private static func days(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400
        let dayOfYear = (153 * ((month + 9) % 12) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }
}

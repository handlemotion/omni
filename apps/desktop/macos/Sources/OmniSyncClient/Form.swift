import Foundation

/// An `application/x-www-form-urlencoded` body. `URLComponents` leaves `+` and `&`-safe
/// characters alone, which a form decoder reads as a space; everything but the unreserved set
/// is escaped here.
func formBody(_ fields: [(String, String)]) -> Data {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    let encode = { (value: String) in value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value }
    return Data(fields.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&").utf8)
}

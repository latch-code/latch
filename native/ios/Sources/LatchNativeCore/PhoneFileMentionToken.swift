import Foundation

// Both Web completion menus use ECMAScript whitespace, which excludes U+0085 and includes U+FEFF.
public func phonePromptWhitespace(_ unit: UInt16) -> Bool {
    [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279].contains(unit) || (8192...8202).contains(unit)
}

public func phonePromptTrim(_ text: String) -> String {
    guard text.utf16.first.map(phonePromptWhitespace) == true || text.utf16.last.map(phonePromptWhitespace) == true else { return text }
    let units = Array(text.utf16), start = units.firstIndex { !phonePromptWhitespace($0) } ?? units.count
    let end = units.lastIndex { !phonePromptWhitespace($0) }.map { $0 + 1 } ?? start
    return String(decoding: units[start..<end], as: UTF16.self)
}

public struct PhoneFileMentionToken: Equatable, Sendable {
    public let query: String
    private let range: NSRange

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.range == rhs.range && lhs.query.utf8.elementsEqual(rhs.query.utf8)
    }

    public static func active(in text: String, selection: NSRange, continuing previous: Self? = nil) -> Self? {
        let body = text as NSString, end = selection.location
        guard selection.length == 0, end > 0, end <= body.length,
              end == body.length || !(0xDC00...0xDFFF).contains(body.character(at: end)) else { return nil }
        var start = end
        while start > 0 {
            start -= 1
            let unit = body.character(at: start)
            if phonePromptWhitespace(unit) { return nil }
            if unit == 64 {
                if PhoneInputReferences.materialRanges(in: text).contains(where: { NSLocationInRange(start, $0) }) { return nil }
                let query = body.substring(with: NSRange(location: start + 1, length: end - start - 1))
                if start > 0, !phonePromptWhitespace(body.character(at: start - 1)) {
                    var prefix = start
                    while prefix > 0, !phonePromptWhitespace(body.character(at: prefix - 1)) {
                        prefix -= 1
                        if body.character(at: prefix) == 64 { return nil }
                    }
                    // Opening a draft or pasting an email should not open suggestions. A person already
                    // narrowing a menu can type a full dotted filename, such as 111@eden.proxy.ts.
                    if previous?.range.location != start, body.character(at: start - 1) < 128, query.contains("."),
                       query.range(of: #"^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil { return nil }
                }
                return Self(query: query, range: NSRange(location: start, length: end - start))
            }
        }
        return nil
    }

    public func inserting(root: String, path: String, in text: String, selection: NSRange) -> (text: String, selection: NSRange)? {
        inserting(marker: Self.marker(root: root, path: path), in: text, selection: selection)
    }

    public func inserting(marker: String, in text: String, selection: NSRange) -> (text: String, selection: NSRange)? {
        guard Self.active(in: text, selection: selection, continuing: self) == self else { return nil }
        let body = text as NSString
        let inline = range.location > 0 && !phonePromptWhitespace(body.character(at: range.location - 1))
        // The chip absorbs this delimiter. Only an explicit choice creates a standalone sendable marker.
        return replace(in: body, with: (inline ? " " : "") + marker + " ")
    }

    /** Discussion keeps the chosen recipient beside the input and drops whitespace left at the start. */
    public func removing(in text: String, selection: NSRange) -> (text: String, selection: NSRange)? {
        guard Self.active(in: text, selection: selection, continuing: self) == self else { return nil }
        let edit = replace(in: text as NSString, with: "")
        let body = edit.text as NSString
        var start = 0
        while start < body.length && phonePromptWhitespace(body.character(at: start)) { start += 1 }
        return (body.substring(from: start), NSRange(location: max(0, edit.selection.location - start), length: 0))
    }

    private func replace(in text: NSString, with replacement: String) -> (text: String, selection: NSRange) {
        let edited = text.replacingCharacters(in: range, with: replacement)
        return (edited, NSRange(location: range.location + replacement.utf16.count, length: 0))
    }

    /** Only a standalone marker with the Host's exact path spelling retains its file. */
    public static func contains(root: String, path: String, in text: String) -> Bool {
        !ranges(marker: marker(root: root, path: path), in: text, excluding: PhoneInputReferences.materialRanges(in: text)).isEmpty
    }

    public static func ranges(marker: String, in text: String, excluding materials: [NSRange] = []) -> [NSRange] {
        guard !marker.isEmpty else { return [] }
        let body = text as NSString
        var ranges = [NSRange]()
        var start = 0
        while start < body.length {
            let match = body.range(of: marker, options: .literal, range: NSRange(location: start, length: body.length - start))
            guard match.location != NSNotFound else { break }
            let end = NSMaxRange(match)
            if (match.location == 0 || phonePromptWhitespace(body.character(at: match.location - 1))),
               (end == body.length || phonePromptWhitespace(body.character(at: end))),
               !materials.contains(where: { NSIntersectionRange($0, match).length > 0 }) { ranges.append(match) }
            start = match.location + 1
        }
        return ranges
    }

    private static func marker(root: String, path: String) -> String { "@\(root):\(path)" }
}

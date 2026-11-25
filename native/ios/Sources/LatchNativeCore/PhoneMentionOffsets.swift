import Foundation

/** Each sorted, non-overlapping source range occupies one attachment character in the native editor. */
public struct PhoneMentionOffsets: Equatable, Sendable {
    public let ranges: [NSRange]
    public init(ranges: [NSRange]) { self.ranges = ranges }

    /** One ASCII delimiter between a chip and its neighbour belongs to the chip in the editor.
     * Preserve indentation, extra spaces, tabs and line breaks. Adjacent chips share one delimiter. */
    public init(markers: [NSRange], in source: String) {
        let text = source as NSString
        var previousEnd = 0
        ranges = markers.map { marker in
            var start = marker.location, end = NSMaxRange(marker)
            if start > previousEnd, text.character(at: start - 1) == 32 {
                var firstSpace = start - 1
                while firstSpace > previousEnd && text.character(at: firstSpace - 1) == 32 { firstSpace -= 1 }
                if firstSpace > previousEnd && !phonePromptWhitespace(text.character(at: firstSpace - 1)) { start -= 1 }
            }
            if end < text.length && text.character(at: end) == 32 { end += 1 }
            previousEnd = end
            return NSRange(location: start, length: end - start)
        }
    }

    public func sourceRange(for displayed: NSRange) -> NSRange {
        func offset(_ position: Int) -> Int {
            var extra = 0
            for range in ranges {
                if position <= range.location - extra { break }
                extra += range.length - 1
            }
            return position + extra
        }
        let start = offset(displayed.location)
        return NSRange(location: start, length: offset(NSMaxRange(displayed)) - start)
    }

    public func displayRange(for source: NSRange) -> NSRange {
        func offset(_ position: Int, after: Bool) -> Int {
            var extra = 0
            for range in ranges {
                if position <= range.location { break }
                if position < NSMaxRange(range) { return range.location - extra + (after ? 1 : 0) }
                extra += range.length - 1
            }
            return position - extra
        }
        let start = offset(source.location, after: source.length == 0)
        return NSRange(location: start, length: offset(NSMaxRange(source), after: true) - start)
    }
}

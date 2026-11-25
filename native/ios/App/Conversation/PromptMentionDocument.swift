import Foundation
import LatchNativeCore
import UIKit

/** Read the live storage, including typing, native undo and pasted literal U+FFFC characters. Only our chips expand. */
@MainActor struct PromptMentionDocument {
    static let marker = NSAttributedString.Key("LatchPromptMention")
    static let trailingDelimiter = NSAttributedString.Key("LatchPromptMentionDelimiter")
    let source: String
    let offsets: PhoneMentionOffsets

    init(storage: NSAttributedString, copying: Bool = false) {
        let plain = storage.string as NSString
        var ranges: [NSRange] = [], result = "", end = 0, extra = 0
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { attachment, run, _ in
            guard attachment is NSTextAttachment else { return }
            for index in run.location..<NSMaxRange(run) {
                guard plain.character(at: index) == 0xFFFC,
                      let marker = storage.attribute(Self.marker, at: index, effectiveRange: nil) as? String else { continue }
                result += plain.substring(with: NSRange(location: end, length: index - end))
                // Restore boundaries from visible neighbours after an edit. Two adjacent chips share the left
                // chip's separator, even if deleting text has just brought them together.
                var wordEnd = index
                while wordEnd > end && plain.character(at: wordEnd - 1) == 32 { wordEnd -= 1 }
                let leading = wordEnd > end && !phonePromptWhitespace(plain.character(at: wordEnd - 1))
                let next = index + 1
                let hadTrailing = storage.attribute(Self.trailingDelimiter, at: index, effectiveRange: nil) != nil
                let trailing: Bool
                if next == plain.length { trailing = hadTrailing && !copying }
                else {
                    let unit = plain.character(at: next)
                    trailing = unit == 32 || !phonePromptWhitespace(unit) || hadTrailing
                }
                let spelling = (leading ? " " : "") + marker + (trailing ? " " : "")
                result += spelling
                ranges.append(NSRange(location: index + extra, length: spelling.utf16.count))
                extra += spelling.utf16.count - 1; end = next
            }
        }
        source = ranges.isEmpty ? storage.string : result + plain.substring(from: end)
        offsets = PhoneMentionOffsets(ranges: ranges)
    }

    struct Match {
        let range: NSRange
        let chip: PromptMentionChip
    }

    static func matches(_ chips: [PromptMentionChip], in text: String) -> [Match] {
        guard !chips.isEmpty, text.contains("@") else { return [] }
        var candidates: [Match] = []
        let materials = PhoneInputReferences.materialRanges(in: text)
        for chip in chips {
            for range in PhoneFileMentionToken.ranges(marker: chip.marker, in: text, excluding: materials) {
                candidates.append(Match(range: range, chip: chip))
            }
        }
        candidates.sort { lhs, rhs in
            if lhs.range.location == rhs.range.location { return lhs.range.length > rhs.range.length }
            return lhs.range.location < rhs.range.location
        }
        // A filename can itself contain whitespace and a standalone member name.
        var end = 0
        return candidates.filter { match in
            guard match.range.location >= end else { return false }
            end = NSMaxRange(match.range); return true
        }
    }
}

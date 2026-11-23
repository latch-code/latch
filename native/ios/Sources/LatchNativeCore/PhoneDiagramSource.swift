import Foundation

public enum PhoneDiagramSource {
    /** Prepare only the renderer's copy. The source view and clipboard keep what the author wrote. */
    public static func prepare(_ source: String) -> String? {
        guard !source.isEmpty, source.utf8.count <= 50_000,
              source.range(of: #"(?im)%%\s*\{|^\s*---|(?:^|;)\s*(?:click|linkStyle|classDef|style)\s"#,
                           options: .regularExpression) == nil else { return nil }
        // Bound recursive diagram rows and flowchart fan-out before the third-party parser expands them.
        let statements = source.split { $0.isNewline || $0 == ";" }
        guard statements.count <= 256, statements.allSatisfy({ $0.utf8.count <= 2048 }),
              source.utf8.filter({ $0 == UInt8(ascii: "&") }).count <= 32 else { return nil }
        let header = statements.lazy.map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("%%") }?.split(whereSeparator: \.isWhitespace).first
        guard header == "flowchart" || header == "graph" else { return source }
        // MermaidKit draws <br/> in node and edge labels. Agents also write a literal backslash-n,
        // or a line break in a quoted label. Keep escaped backslashes and statement boundaries intact.
        var result = "", closing: Character?, quoted = false
        var position = source.startIndex
        while position < source.endIndex {
            let character = source[position]
            source.formIndex(after: &position)
            // The quoted form surrounds an edge label; MermaidKit keeps those quote marks as ink.
            // Use the equivalent pipe form only outside labels, leaving quoted node text untouched.
            if closing == nil, character == "-",
               let edge = source[position...].prefixMatch(of: #/-[ \t]+"([^"\\|\r\n]+)"[ \t]+-->/#) {
                result += "-->|\(edge.1)|"
                position = edge.range.upperBound
                continue
            }
            if let end = closing {
                if character == "\\", position < source.endIndex {
                    let next = source[position]
                    if next == "n" || next == "\\" || (quoted && next == "\"") {
                        source.formIndex(after: &position)
                        if next == "n" { result += "<br/>" } else { result.append(character); result.append(next) }
                        continue
                    }
                }
                if character == "\"" { quoted.toggle() }
                if !quoted && (character == end || character.isNewline) { closing = nil }
                if quoted && character.isNewline { result += "<br/>"; continue }
            } else {
                switch character {
                case "[": closing = "]"
                case "{": closing = "}"
                case "(": closing = ")"
                case "|": closing = "|"
                default: break
                }
            }
            result.append(character)
        }
        return result
    }
}

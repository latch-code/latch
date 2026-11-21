import SwiftUI
import UIKit

/**
 * Code colours by role, in the web's --syn-* palette: keywords, strings, comments, numbers and called names, read by a
 * small scanner per language family. It never runs or loads anything; a language it does not know, or a block too long
 * to scan quickly, stays in the plain ink.
 */
enum CodeHighlight {
    private struct Family {
        var line: [String] = []
        var block: [(String, String)] = []
        var quotes: Set<Character> = ["\"", "'"]
        var keywords: Set<String> = []
        var calls = true
        var caseless = false
    }
    private static let cLike: Set<String> = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "func", "function",
        "let", "var", "const", "class", "struct", "enum", "interface", "type", "extends", "implements", "import", "export", "from", "as", "new", "this", "self",
        "super", "try", "catch", "finally", "throw", "throws", "async", "await", "public", "private", "protected", "static", "final", "void", "true", "false",
        "null", "nil", "undefined", "in", "of", "is", "guard", "defer", "where", "extension", "protocol", "package", "go", "fn", "impl", "mut", "pub", "use",
        "mod", "match", "trait", "yield", "typeof", "instanceof", "int", "string", "bool", "float", "double", "char", "long", "override", "init", "deinit",
        "inout", "some", "any", "readonly", "namespace", "declare", "module", "require", "lazy", "weak", "unsafe", "chan", "select", "range", "map", "val",
        "object", "when", "data", "sealed", "open", "internal", "abstract", "virtual", "using", "include", "define", "auto", "constexpr", "template", "typename"]
    private static let script: Set<String> = ["if", "elif", "else", "fi", "then", "for", "while", "do", "done", "case", "esac", "in", "def", "class", "return",
        "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "yield", "pass", "break", "continue", "and", "or", "not", "is", "None",
        "True", "False", "global", "nonlocal", "async", "await", "function", "local", "export", "echo", "end", "module", "require", "unless", "until",
        "begin", "rescue", "ensure", "nil", "true", "false", "self", "puts", "elsif", "then", "set", "unset", "source", "alias", "readonly", "declare"]
    private static let query: Set<String> = ["select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create",
        "table", "drop", "alter", "index", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "limit", "as", "distinct", "having",
        "union", "null", "is", "in", "like", "primary", "key", "references", "default", "local", "function", "end", "then", "if", "else", "return",
        "true", "false", "nil", "for", "do", "while", "let", "where", "case", "of", "data", "module", "import"]
    private static func family(_ language: String) -> Family? {
        switch language.lowercased() {
        case "swift", "js", "javascript", "jsx", "mjs", "cjs", "ts", "typescript", "tsx", "java", "kotlin", "kt", "go", "golang", "rust", "rs", "c", "h",
             "cpp", "c++", "cc", "cxx", "hpp", "cs", "csharp", "objc", "objective-c", "m", "php", "dart", "scala", "groovy", "gradle", "zig", "proto":
            return Family(line: ["//"], block: [("/*", "*/")], quotes: ["\"", "'", "`"], keywords: cLike)
        case "python", "py", "ruby", "rb", "sh", "bash", "zsh", "shell", "console", "fish", "yaml", "yml", "toml", "dockerfile", "docker", "makefile",
             "make", "r", "perl", "pl", "nginx", "ini", "conf", "env", "properties", "powershell", "ps1", "elixir", "ex", "nim", "cmake":
            return Family(line: ["#"], quotes: ["\"", "'"], keywords: script)
        case "sql", "lua", "haskell", "hs", "elm", "ada":
            return Family(line: ["--"], block: [("/*", "*/"), ("{-", "-}"), ("--[[", "]]")], quotes: ["\"", "'"], keywords: query, caseless: true)
        case "json", "jsonc", "json5":
            return Family(line: ["//"], block: [("/*", "*/")], quotes: ["\""], keywords: ["true", "false", "null"], calls: false)
        case "css", "scss", "sass", "less":
            return Family(line: ["//"], block: [("/*", "*/")], quotes: ["\"", "'"], keywords: ["important", "media", "import", "keyframes", "from", "to"], calls: false)
        case "html", "xml", "svg", "vue", "svelte", "xhtml", "plist":
            return Family(block: [("<!--", "-->")], quotes: ["\"", "'"], keywords: [], calls: false)
        default: return nil
        }
    }

    static func attributed(_ code: String, language: String?, size: CGFloat) -> NSAttributedString {
        let font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        let style = NSMutableParagraphStyle(); style.minimumLineHeight = size * 1.5; style.maximumLineHeight = size * 1.5
        let result = NSMutableAttributedString(string: code, attributes: [.font: font, .foregroundColor: PhoneTheme.syntax(.plain), .paragraphStyle: style])
        guard let language, code.utf16.count <= 120_000 else { return result }
        if ["diff", "patch"].contains(language.lowercased()) { diff(result, code); return result }
        guard let family = family(language) else { return result }
        let text = code as NSString, length = text.length
        func paint(_ range: NSRange, _ role: PhoneTheme.Syntax) { result.addAttribute(.foregroundColor, value: PhoneTheme.syntax(role), range: range) }
        func starts(_ token: String, at index: Int) -> Bool {
            let count = (token as NSString).length
            return index + count <= length && text.substring(with: NSRange(location: index, length: count)) == token
        }
        var index = 0
        scan: while index < length {
            if let token = family.line.first(where: { starts($0, at: index) }), token != "#" || index == 0 || !isWord(text.character(at: index - 1)) {
                let end = text.range(of: "\n", options: [], range: NSRange(location: index, length: length - index)).location
                let stop = end == NSNotFound ? length : end
                paint(NSRange(location: index, length: stop - index), .comment); index = stop; continue
            }
            for (open, close) in family.block where starts(open, at: index) {
                let found = text.range(of: close, options: [], range: NSRange(location: index + (open as NSString).length, length: length - index - (open as NSString).length))
                let stop = found.location == NSNotFound ? length : found.location + found.length
                paint(NSRange(location: index, length: stop - index), .comment); index = stop; continue scan
            }
            let unit = text.character(at: index)
            if let scalar = Unicode.Scalar(unit), family.quotes.contains(Character(scalar)) {
                var cursor = index + 1
                while cursor < length {
                    let next = text.character(at: cursor)
                    if next == 92 { cursor += 2; continue }
                    if next == unit { cursor += 1; break }
                    if next == 10 && unit != 96 { break }
                    cursor += 1
                }
                let stop = min(cursor, length)
                paint(NSRange(location: index, length: stop - index), .string); index = stop; continue
            }
            if isDigit(unit), index == 0 || !isWord(text.character(at: index - 1)) {
                var cursor = index + 1
                while cursor < length, isWord(text.character(at: cursor)) || text.character(at: cursor) == 46 { cursor += 1 }
                paint(NSRange(location: index, length: cursor - index), .number); index = cursor; continue
            }
            if isWord(unit) {
                var cursor = index + 1
                while cursor < length, isWord(text.character(at: cursor)) { cursor += 1 }
                let word = text.substring(with: NSRange(location: index, length: cursor - index))
                if family.keywords.contains(family.caseless ? word.lowercased() : word) { paint(NSRange(location: index, length: cursor - index), .keyword) }
                else if family.calls, cursor < length, text.character(at: cursor) == 40 { paint(NSRange(location: index, length: cursor - index), .function) }
                index = cursor; continue
            }
            if family.keywords.isEmpty, unit == 60 {
                // A tag's name in markup.
                var cursor = index + 1
                if cursor < length, text.character(at: cursor) == 47 { cursor += 1 }
                let start = cursor
                while cursor < length, isWord(text.character(at: cursor)) || text.character(at: cursor) == 45 { cursor += 1 }
                if cursor > start { paint(NSRange(location: start, length: cursor - start), .keyword) }
                index = max(cursor, index + 1); continue
            }
            index += 1
        }
        return result
    }
    private static func diff(_ result: NSMutableAttributedString, _ code: String) {
        var location = 0
        for line in code.components(separatedBy: "\n") {
            let length = (line as NSString).length, range = NSRange(location: location, length: length)
            if line.hasPrefix("+"), !line.hasPrefix("+++") { result.addAttribute(.foregroundColor, value: UIColor(PhoneTheme.green), range: range) }
            else if line.hasPrefix("-"), !line.hasPrefix("---") { result.addAttribute(.foregroundColor, value: UIColor(PhoneTheme.red), range: range) }
            else if line.hasPrefix("@@") { result.addAttribute(.foregroundColor, value: PhoneTheme.syntax(.function), range: range) }
            location += length + 1
        }
    }
    private static func isDigit(_ unit: unichar) -> Bool { unit >= 48 && unit <= 57 }
    private static func isWord(_ unit: unichar) -> Bool { isDigit(unit) || (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || unit == 95 || unit == 36 }
}

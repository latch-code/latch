import Foundation
import LatchNativeCore

enum PreviewTextFormat {
    case plain
    case markdown(PreviewDocumentOrigin?)

    init(meta: NativeJSON, session: String, attachment: Bool, access: NativeFileAccess?) {
        guard meta["kind"].string == "markdown", meta["secret"] == .bool(false), meta["actions"]["preview"] == .bool(true)
        else { self = .plain; return }
        self = .markdown(attachment ? nil : PreviewDocumentOrigin(meta: meta, session: session, access: access))
    }
}

/** Only the Host's resolved project file supplies a base for links in this document. */
struct PreviewDocumentOrigin {
    let session: String
    let root: String
    let access: NativeFileAccess
    private let directory: [Substring]

    init?(meta: NativeJSON, session: String, access: NativeFileAccess?) {
        guard let access, meta["source"] == .null, meta["folder"] == .null,
              let root = meta["root"].string, !root.hasPrefix("outside-"), LinkBytes.matches(root, "[A-Za-z0-9_-]{1,32}"),
              let path = meta["path"].string, let name = meta["name"].string, Self.clean(path) else { return nil }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              components.last?.utf8.elementsEqual(name.utf8) == true else { return nil }
        self.session = session
        self.root = root
        self.access = access
        directory = Array(components.dropLast())
    }

    func reference(_ link: String) -> String? {
        guard Self.clean(link), !link.hasPrefix("~"), !link.hasSuffix("/"),
              link.range(of: #"^[a-zA-Z][a-zA-Z0-9+.\-]*:"#,
                         options: .regularExpression) == nil else { return nil }
        var parts = directory
        let components = link.split(separator: "/")
        guard let last = components.last, last != ".", last != ".." else { return nil }
        for part in components {
            if part == ".." {
                guard parts.popLast() != nil else { return nil }
            } else if part != "." { parts.append(part) }
        }
        // Make the reference explicitly relative even when a folder is literally named "file:" or "~".
        let relative = "./" + parts.joined(separator: "/")
        return relative.utf8.count <= 4096 ? relative : nil
    }

    private static func clean(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 4096 && !value.hasPrefix("/") && !value.contains("\\")
            && value.rangeOfCharacter(from: .controlCharacters) == nil
    }
}

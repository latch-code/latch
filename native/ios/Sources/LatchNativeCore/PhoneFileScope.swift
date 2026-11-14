import Foundation

/** Folder identities frozen by the Host for this session. This is lexical grouping, never file authorization. */
public struct PhoneFileScope: Equatable, Sendable {
    private struct Root: Equatable, Sendable {
        let id: String
        let path: String
        static func == (left: Root, right: Root) -> Bool { left.id == right.id && left.path.utf8.elementsEqual(right.path.utf8) }
    }
    private let roots: [Root]
    public init(_ summary: NativeJSON = .null) {
        let listed = summary["folders"].array
        if !listed.isEmpty {
            let parsed = listed.compactMap { value -> Root? in
                guard let id = value["id"].string, LinkBytes.matches(id, "[A-Za-z0-9_-]{1,32}"),
                      let path = value["path"].string, Self.absolute(path) else { return nil }
                return Root(id: id, path: path)
            }
            roots = parsed.count == listed.count && Set(parsed.map(\.id)).count == parsed.count ? parsed : []
        } else if let cwd = summary["cwd"].string, Self.absolute(cwd) { roots = [Root(id: "default", path: cwd)] }
        else { roots = [] }
    }
    private static func relative(_ path: String) -> Bool {
        !path.isEmpty && path.utf8.count <= 4096 && !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
            && path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
    private static func absolute(_ path: String) -> Bool { path == "/" || path.hasPrefix("/") && relative(String(path.dropFirst())) }
    private func inside(_ path: String, root: Root) -> String? {
        let prefix = root.path == "/" ? "/" : root.path + "/"
        guard path.utf8.starts(with: prefix.utf8) else { return nil }
        let relative = String(decoding: path.utf8.dropFirst(prefix.utf8.count), as: UTF8.self)
        return Self.relative(relative) ? relative : nil
    }
    // Swift String equality normalizes Unicode; a Host filesystem need not. ASCII keys preserve its exact UTF-8 identity.
    private func key(_ path: String) -> String { LinkBytes.base64url(Data(path.utf8)) }
    /** An unresolved path stays distinct, including its explicit root. No basename or suffix matching. */
    func reference(path: String, root: String?) -> (id: String, path: String, root: String?) {
        if root == nil, Self.absolute(path),
           let folder = roots.filter({ inside(path, root: $0) != nil }).max(by: { $0.path.utf8.count < $1.path.utf8.count }),
           let relative = inside(path, root: folder) {
            return ("absolute:" + key(path), relative, folder.id)
        }
        if Self.relative(path), let folder = root.flatMap({ id in roots.first { $0.id == id } }) ?? (root == nil ? roots.first : nil) {
            let absolute = (folder.path == "/" ? "/" : folder.path + "/") + path
            return ("absolute:" + key(absolute), path, folder.id)
        }
        return ("unresolved:" + key(root ?? "") + ":" + key(path), path, root)
    }
}

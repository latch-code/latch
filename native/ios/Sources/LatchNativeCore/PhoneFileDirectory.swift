import Foundation

/** The window and transport that authorized a file panel. A reconnect invalidates the old panel even if its lease survives. */
public struct NativeFileAccess: Sendable {
    public let lease: BodyLease
    public let transport: NativeTransportEpoch
    public init(lease: BodyLease, transport: NativeTransportEpoch) { self.lease = lease; self.transport = transport }
    func check(_ installed: NativeTransportEpoch?, window: BodyLease?) throws {
        try Task.checkCancellation()
        guard transport === installed, transport.valid else { throw NativeFailure.contextChanged }
        guard let window, lease.sameWindow(as: window) else { throw NativeFailure.expired }
        try lease.requireValid()
    }
}

/** A folder within one of the roots returned for this session. A nil root requests the root list. */
public struct PhoneFileFolder: Hashable, Sendable {
    public let root: String?
    public let dir: String
    public init(root: String? = nil, dir: String = "") { self.root = root; self.dir = dir }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.root == rhs.root && lhs.dir.utf8.elementsEqual(rhs.dir.utf8)
    }
    public func hash(into hasher: inout Hasher) { hasher.combine(root); hasher.combine(Data(dir.utf8)) }

    public func appending(_ name: String) -> String { dir.isEmpty ? name : dir + "/" + name }
    static func validName(_ name: String) -> Bool {
        !name.isEmpty && name.utf16.count <= 256 && name != "." && name != ".."
            && !name.contains("/") && !name.contains("\\") && !name.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }
    public func path(session: String) throws -> String {
        guard LinkBytes.matches(session, "[A-Za-z0-9_-]{1,160}"), dir.utf8.count <= 4096,
              dir.isEmpty || dir.components(separatedBy: "/").allSatisfy(Self.validName) else { throw NativeFailure.invalidRecord }
        let base = "/link/api/tasks/" + session + "/files/list"
        guard let root else { guard dir.isEmpty else { throw NativeFailure.invalidRecord }; return base }
        guard LinkBytes.matches(root, "[A-Za-z0-9_-]{1,32}") else { throw NativeFailure.invalidRecord }
        let path = base + "?rootId=" + root + (dir.isEmpty ? "" : "&dir=" + PhoneWorkItems.query(dir))
        guard path.utf8.count <= 4096 else { throw NativeFailure.invalidRecord }
        return path
    }
}

public struct PhoneFileDirectory: Sendable {
    public struct Root: Identifiable, Sendable { public let id: String; public let name: String }
    public struct Entry: Identifiable, Sendable {
        public enum Kind: String, Sendable { case file, directory, symlink, other }
        public let name: String
        public let kind: Kind
        // Canonically equivalent names can identify distinct files on the Host.
        public var id: Data { Data(name.utf8) }
    }
    public let roots: [Root]
    public let entries: [Entry]
    public let truncated: Bool

    public enum Feature: String, Sendable { case tree = "fileTree", search = "fileSearch" }
    public static func offered(_ snapshot: NativeJSON, session: String, feature: Feature = .tree) -> Bool {
        snapshot["catalog"]["features"][feature.rawValue] == .bool(true) && PhoneWorkItems.canReadFiles(snapshot)
            && PhoneSessions.mayReadBody(snapshot: snapshot, sessionId: session)
    }

    public init(_ value: NativeJSON, session: String, folder: PhoneFileFolder) throws {
        _ = try folder.path(session: session)
        guard value["context"]["kind"].string == "session", value["context"]["sessionId"].string == session,
              case let .array(rootRows) = value["roots"], rootRows.count <= 8,
              case let .array(rows) = value["entries"], rows.count <= 2000,
              case let .bool(truncated) = value["truncated"] else { throw NativeFailure.invalidRecord }
        roots = try rootRows.map { row in
            guard let id = row["id"].string, LinkBytes.matches(id, "[A-Za-z0-9_-]{1,32}"),
                  let name = row["name"].string, name.isEmpty || PhoneFileFolder.validName(name) else { throw NativeFailure.invalidRecord }
            return Root(id: id, name: name)
        }
        guard Set(roots.map(\.id)).count == roots.count else { throw NativeFailure.invalidRecord }
        if let root = folder.root {
            guard value["rootId"].string == root, roots.contains(where: { $0.id == root }),
                  value["dir"].string?.utf8.elementsEqual(folder.dir.utf8) == true else { throw NativeFailure.invalidRecord }
        } else if !rows.isEmpty || value["rootId"] != .null || value["dir"] != .null { throw NativeFailure.invalidRecord }
        entries = try rows.map { row in
            guard let name = row["name"].string, PhoneFileFolder.validName(name),
                  let kind = row["kind"].string.flatMap(Entry.Kind.init(rawValue:)) else { throw NativeFailure.invalidRecord }
            return Entry(name: name, kind: kind)
        }
        guard Set(entries.map(\.id)).count == entries.count else { throw NativeFailure.invalidRecord }
        self.truncated = truncated
    }
}

public struct PhoneFileMatches: Sendable {
    public struct Hit: Identifiable, Sendable {
        public let root: String
        public let path: String
        public let name: String
        public var id: Data { Data((root + "\0" + path).utf8) }
    }
    public let files: [Hit]
    public let truncated: Bool
    public let uncheckedCount: UInt64
    public init(_ value: NativeJSON) throws {
        guard case let .array(rows) = value["files"], rows.count <= 100, case let .bool(truncated) = value["truncated"] else {
            throw NativeFailure.invalidRecord
        }
        if value["unchecked"] == .null { uncheckedCount = 0 }
        else {
            guard let files = value["unchecked"]["files"].integer, let folders = value["unchecked"]["directories"].integer
            else { throw NativeFailure.invalidRecord }
            uncheckedCount = files + folders
        }
        files = try rows.map { row in
            guard let root = row["root"].string, LinkBytes.matches(root, "[A-Za-z0-9_-]{1,32}"),
                  let name = row["name"].string, let path = row["path"].string, path.utf8.count <= 4096 else { throw NativeFailure.invalidRecord }
            let parts = path.components(separatedBy: "/")
            guard parts.allSatisfy(PhoneFileFolder.validName), parts.last?.utf8.elementsEqual(name.utf8) == true else { throw NativeFailure.invalidRecord }
            return Hit(root: root, path: path, name: name)
        }
        guard Set(files.map(\.id)).count == files.count else { throw NativeFailure.invalidRecord }
        self.truncated = truncated
    }
}

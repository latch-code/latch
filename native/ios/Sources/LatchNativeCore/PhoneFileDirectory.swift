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
        public let ignored: Bool
        public var id: Data { Data((root + "\0" + path).utf8) }
    }
    public let files: [Hit]
    public let truncated: Bool
    public let uncheckedCount: UInt64
    public init(_ value: NativeJSON, forMentions: Bool = false) throws {
        guard case let .array(rows) = value["files"], rows.count <= 100, case let .bool(truncated) = value["truncated"] else {
            throw NativeFailure.invalidRecord
        }
        if value["unchecked"] == .null { uncheckedCount = 0 }
        else {
            guard let files = value["unchecked"]["files"].integer, let folders = value["unchecked"]["directories"].integer
            else { throw NativeFailure.invalidRecord }
            uncheckedCount = files + folders
        }
        files = try rows.compactMap { row in
            guard let root = row["root"].string, LinkBytes.matches(root, "[A-Za-z0-9_-]{1,32}"),
                  let name = row["name"].string, let path = row["path"].string, path.utf8.count <= 4096 else { throw NativeFailure.invalidRecord }
            // The file picker can preview Unix names like "C:notes". Such paths are invalid on a message reference.
            if forMentions, path.range(of: "^[A-Za-z]:", options: .regularExpression) != nil { return nil }
            let parts = path.components(separatedBy: "/")
            guard parts.allSatisfy(PhoneFileFolder.validName), parts.last?.utf8.elementsEqual(name.utf8) == true else { throw NativeFailure.invalidRecord }
            return Hit(root: root, path: path, name: name, ignored: row["ignored"].bool)
        }
        guard Set(files.map(\.id)).count == files.count else { throw NativeFailure.invalidRecord }
        self.truncated = truncated
    }
}

/** A first message searches the roots of its chosen Harness. Later messages use the Host's frozen session roots. */
public enum PhoneMentionScope: Hashable, Sendable {
    case session(String)
    case project(workspace: String, harness: String)

    public func offered(in snapshot: NativeJSON) -> Bool {
        supported(in: snapshot) && PhoneWorkItems.canReadFiles(snapshot)
    }

    public func supported(in snapshot: NativeJSON) -> Bool {
        let catalog = snapshot["catalog"], device = snapshot["device"]
        guard catalog["features"]["fileMentions"].bool, catalog["features"]["fileSearch"].bool,
              device["status"].string == "active", device["scopes"].array.contains(.string("view")),
              device["scopes"].array.contains(.string("run")) else { return false }
        let harness: String
        switch self {
        case let .session(id):
            guard LinkBytes.matches(id, "[A-Za-z0-9_-]{1,160}"),
                  let row = snapshot["tasks"].array.first(where: { $0["id"].string == id }),
                  row["mode"] == .null || row["mode"].string == "agent", let selected = row["harnessId"].string else { return false }
            harness = selected
        case let .project(workspace, id):
            guard workspace != "default", LinkBytes.matches(workspace, "[a-z0-9][a-z0-9_-]{0,63}"),
                  PhoneStart.projects(catalog).contains(where: { $0.id == workspace }) else { return false }
            harness = id
        }
        return PhoneStart.harness(catalog, harness)["capabilities"]["tools"]["fileMentions"].bool
    }

    /** Attach only explicit choices to a new write. The retry keeps these bytes in its original receipt. */
    public func attach(_ files: [PhoneFileMatches.Hit], to fields: inout [String: NativeJSON], snapshot: NativeJSON) throws {
        guard offered(in: snapshot), fields["queue"] != .bool(true), fields["steer"] != .bool(true),
              files.count <= 32, Set(files.map(\.id)).count == files.count else { throw NativeFailure.forbidden }
        fields["fileRefs"] = .array(files.map { .object(["root": .string($0.root), "path": .string($0.path)]) })
    }
}

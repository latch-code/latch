import Foundation

/** In-memory targets from the selected computer's authenticated list. Only the presence of a question leaves the app. */
public struct PhoneQuestionAttention: Equatable, Sendable {
    public struct Entry: Equatable, Sendable {
        public let session: String
        public let count: Int
    }
    public let computer: String
    public let entries: [Entry]
    public var sessions: [String] { entries.map(\.session) }

    public init?(computer: String, snapshot: NativeJSON) {
        let device = snapshot["device"], scopes = device["scopes"].array
        guard device["status"].string == "active", scopes.contains(.string("view")), scopes.contains(.string("run")),
              snapshot["tasksComplete"].bool, case let .array(tasks) = snapshot["tasks"] else { return nil }
        self.computer = computer
        var seen = Set<String>()
        entries = tasks.compactMap { task in
            guard !task["archived"].bool, PhoneSessions.waitsOnYou(task), let count = task["pendingQuestions"].integer,
                  count > 0, let id = task["id"].string, PhoneComputers.listable(id), seen.insert(id).inserted else { return nil }
            return Entry(session: id, count: Int(clamping: count))
        }
    }

    public func newlyWaiting(since previous: Self?, excluding visibleSession: String?) -> Entry? {
        guard let previous, previous.computer == computer else { return nil }
        let old = Dictionary(uniqueKeysWithValues: previous.entries.map { ($0.session, $0.count) })
        return entries.first { $0.session != visibleSession && $0.count > old[$0.session, default: 0] }
    }
}

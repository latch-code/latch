import Foundation

public enum PhoneWorkReadFailure: Error, Equatable, Sendable {
    case itemMissing, postMissing, replyMissing, checkChanged, versionChanged
}

/** Fixed read routes. POST delivery collects repository facts and creates no request receipt. */
public enum PhoneWorkRead: Sendable {
    case item(String)
    case posts(String, before: String?)
    case post(String, post: String)
    case reply(String, post: String, message: String, offset: Int)
    case delivery([String])
    case commit(String, sha: String, file: String?)
    case pullRequest(String)
    case checkLog(String, job: String)

    public var sessionIds: [String] {
        switch self {
        case let .delivery(ids): ids
        case let .commit(id, _, _), let .pullRequest(id), let .checkLog(id, _): [id]
        default: []
        }
    }

    var fileScope: Bool {
        switch self {
        case .delivery, .commit, .pullRequest, .checkLog: true
        default: false
        }
    }
    public func request() throws -> (method: NativeHTTPMethod, path: String, body: Data?, timeout: Int64) {
        func item(_ id: String) throws -> String {
            guard PhoneWorkItems.validItem(id) else { throw NativeFailure.invalidRecord }
            return "/link/api/work/items/" + id
        }
        func post(_ id: String, _ postId: String) throws -> String {
            guard PhoneWorkItems.validPost(postId) else { throw NativeFailure.invalidRecord }
            return try item(id) + "/posts/" + postId
        }
        func git(_ id: String) throws -> String {
            guard PhoneWorkItems.session(id) != nil else { throw NativeFailure.invalidRecord }
            return "/link/api/tasks/" + id + "/git/"
        }
        switch self {
        case let .item(id):
            return (.get, try item(id), nil, 15)
        case let .posts(id, before):
            if let before, !PhoneWorkItems.validPost(before) { throw NativeFailure.invalidRecord }
            return (.get, try item(id) + "/posts" + (before.map { "?before=" + $0 } ?? ""), nil, 15)
        case let .post(id, postId):
            return (.get, try post(id, postId), nil, 15)
        case let .reply(id, postId, message, offset):
            guard PhoneWorkItems.message(.string(message)) != nil, (0..<PhoneWorkItems.replyLimit).contains(offset) else {
                throw NativeFailure.invalidRecord
            }
            return (.get, try post(id, postId) + "/reply?messageId=" + PhoneWorkItems.query(message) + "&offset=" + String(offset), nil, 15)
        case let .delivery(ids):
            guard (1...12).contains(ids.count), Set(ids).count == ids.count,
                  ids.allSatisfy({ PhoneWorkItems.session($0) != nil }) else { throw NativeFailure.invalidRecord }
            let body = try NativeJSON.object(["ids": .array(ids.map(NativeJSON.string))]).encoded()
            return (.post, "/link/api/workbench/delivery", body, 40)
        case let .commit(id, sha, file):
            guard PhoneWorkItems.sha(sha) != nil else { throw NativeFailure.invalidRecord }
            if let file, file.isEmpty || file.utf8.count > 1024 { throw NativeFailure.invalidRecord }
            return (.get, try git(id) + "history/" + sha + (file.map { "?path=" + PhoneWorkItems.query($0) } ?? ""), nil, 15)
        case let .pullRequest(id):
            return (.get, try git(id) + "pr", nil, 40)
        case let .checkLog(id, job):
            guard PhoneWorkItems.job(job) != nil else { throw NativeFailure.invalidRecord }
            return (.get, try git(id) + "pr/checks/" + job + "/log", nil, 65)
        }
    }
}

public struct PhoneWorkCheck: Equatable, Sendable {
    public enum State: String, Sendable {
        case pass, fail, pending, skipped
        public var label: String {
            switch self {
            case .pass: "通过"
            case .fail: "失败"
            case .pending: "待完成"
            case .skipped: "已跳过"
            }
        }
    }

    public let name: String
    public let workflow: String?
    public let state: State
    public let job: String?

    init?(_ value: NativeJSON) {
        guard let name = PhoneWorkItems.text(value["name"], max: 512), !name.isEmpty,
              let state = value["state"].string.flatMap(State.init) else { return nil }
        let job = value["job"].string.flatMap(PhoneWorkItems.job)
        guard value.object["job"] == nil || (state == .fail && job != nil) else { return nil }
        self.name = name; workflow = PhoneWorkItems.text(value["workflow"], max: 512); self.state = state; self.job = job
    }
}

public struct PhoneWorkPullRequest: Equatable, Sendable {
    public enum State: String, Sendable {
        case open, closed, merged
        public var label: String { switch self { case .open: "开启"; case .closed: "已关闭"; case .merged: "已合并" } }
    }

    public let number: UInt64
    public let title: String
    public let url: URL?
    public let sha: String?
    public let state: State
    public let draft: Bool
    public let review: String?
    public let checks: [PhoneWorkCheck]

    public init?(_ value: NativeJSON) {
        let pr = value["pr"]
        guard let number = pr["number"].integer, number > 0,
              let title = PhoneWorkItems.text(pr["title"], max: 1024),
              let state = pr["state"].string.flatMap(State.init), case let .bool(draft) = pr["draft"],
              case let .array(rows) = value["checks"], rows.count <= 200 else { return nil }
        let checks = rows.compactMap(PhoneWorkCheck.init), sha = pr["headSha"].string.flatMap(PhoneWorkItems.sha)
        guard checks.count == rows.count, pr.object["headSha"] == nil || sha != nil else { return nil }
        let href = pr["url"].string.flatMap { raw -> URL? in
            guard raw.utf8.count <= 2048, let components = URLComponents(string: raw), components.scheme == "https",
                  let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
                  components.query == nil, components.fragment == nil else { return nil }
            let path = components.path.split(separator: "/")
            guard path.count == 4, path[2] == "pull", path[3] == String(number) else { return nil }
            return components.url
        }
        self.number = number; self.title = title; url = href; self.sha = sha; self.state = state; self.draft = draft
        review = switch pr["reviewDecision"].string {
        case "approved": "PR 审阅已批准"
        case "changes-requested": "PR 审阅要求修改"
        case "review-required": "PR 待审阅"
        default: nil
        }
        self.checks = checks
    }
    public func failedCheck(job: String, sha: String) -> PhoneWorkCheck? {
        guard self.sha == sha else { return nil }
        let matching = checks.filter { $0.job == job && $0.state == .fail }
        return matching.count == 1 ? matching[0] : nil
    }
}

/** The socket and NativeJSON set the total byte budget. Host clips each comment in UTF-16 units. */
public struct PhoneWorkPRDiscussion: Sendable {
    public let comments: [NativeJSON]
    public let capped: Bool

    public init(_ answer: NativeJSON) {
        guard case let .array(rows) = answer["discussion"] else { comments = []; capped = false; return }
        let valid = rows.prefix(200).filter { row in
            row["body"].string.map { $0.utf16.count <= 8192 } == true
        }
        comments = Array(valid)
        capped = answer["discussionCapped"] == .bool(true) || valid.count < rows.count
    }
}

public struct PhoneWorkEvidence: Equatable, Sendable {
    public enum Version: Equatable, Sendable { case same, different, unconfirmed }

    public let sessionId: String
    public let head: String?
    public let pr: PhoneWorkPullRequest?
    public let observedAt: Date?
    public let prObservedAt: Date?
    public let notRepository: Bool
    public let stateFailed: Bool
    public let prFailed: Bool

    public var version: Version {
        guard let head, let sha = pr?.sha else { return .unconfirmed }
        return head == sha ? .same : .different
    }

    public init?(_ value: NativeJSON) {
        guard let session = value["sessionId"].string.flatMap(PhoneWorkItems.session) else { return nil }
        let head = value["state"]["head"].string.flatMap(PhoneWorkItems.sha)
        guard value["state"].object["head"] == nil || head != nil else { return nil }
        let pullRequest = value["pr"], pr = PhoneWorkPullRequest(pullRequest)
        let unbound = pullRequest.object["pr"] == nil && pullRequest["checks"] == .array([])
        guard value.object["pr"] == nil || pr != nil || unbound else { return nil }
        sessionId = session; self.head = head; self.pr = pr
        observedAt = PhoneTime.parse(value["observedAt"]); prObservedAt = PhoneTime.parse(value["prObservedAt"])
        notRepository = value["notApplicable"].string == "not-repository"
        stateFailed = value.object["error"] != nil
        prFailed = value.object["prError"] != nil
    }

    public static func read(_ answer: NativeJSON, sessions: [String]) throws -> [Self] {
        guard case let .array(rows) = answer["entries"], rows.count <= 12 else { throw NativeFailure.invalidRecord }
        let parsed = rows.compactMap(Self.init)
        guard parsed.count == rows.count, parsed.count == sessions.count,
              Set(parsed.map(\.sessionId)) == Set(sessions) else { throw NativeFailure.invalidRecord }
        return parsed
    }
}

public struct PhoneWorkCommit: Equatable, Sendable {
    public struct File: Equatable, Sendable, Identifiable {
        public var id: Data { Data(path.utf8) }
        public let path: String
        public let status: String
        public let add: UInt64?
        public let del: UInt64?
        public let binary: Bool

        init?(_ value: NativeJSON) {
            guard let path = value["path"].string, !path.isEmpty, path.utf8.count <= 1024,
                  let status = value["status"].string, ["A", "M", "D", "T"].contains(status) else { return nil }
            self.path = path; self.status = status; add = value["add"].integer; del = value["del"].integer
            binary = value["binary"] == .bool(true)
        }
    }

    public let sha: String
    public let files: [File]
    public let more: UInt64

    public init(_ value: NativeJSON, sha: String) throws {
        guard PhoneWorkItems.sha(sha) != nil, value["sha"].string == sha,
              case let .array(rows) = value["files"], rows.count <= 500 else { throw PhoneWorkReadFailure.versionChanged }
        let files = rows.compactMap(File.init)
        guard files.count == rows.count, Set(files.map(\.id)).count == files.count else { throw NativeFailure.invalidRecord }
        self.sha = sha; self.files = files; more = value["more"].integer ?? 0
    }

    public static func file(_ value: NativeJSON, sha: String, path: String) throws -> (lines: [PhoneReviewLine], hidden: String?) {
        guard value["sha"].string == sha, let file = File(value["file"]), PhoneWorkItems.same(file.path, path) else {
            throw PhoneWorkReadFailure.versionChanged
        }
        if let reason = value["hidden"].string {
            let label = switch reason {
            case "binary": "二进制文件"
            case "large": "文件过大"
            case "secret": "此文件可能包含敏感内容"
            case "link": "符号链接"
            default: "文件内容不可用"
            }
            return ([], label)
        }
        guard case .array = value["hunks"] else { throw NativeFailure.invalidRecord }
        return (PhoneReview.lines(value), nil)
    }
}

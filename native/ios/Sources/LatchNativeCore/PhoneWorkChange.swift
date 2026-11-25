import Foundation

public enum PhoneWorkPostTarget: Hashable, Sendable {
    case session(String), agent(String)

    init?(_ value: NativeJSON) {
        guard value.object.count == 1 else { return nil }
        if let id = value["sessionId"].string.flatMap(PhoneWorkItems.session) { self = .session(id) }
        else if let id = value["customAgentId"].string, PhoneAgents.validId(id) { self = .agent(id) }
        else { return nil }
    }
    var wire: NativeJSON {
        switch self {
        case let .session(id): .object(["sessionId": .string(id)])
        case let .agent(id): .object(["customAgentId": .string(id)])
        }
    }
}

/** A person's work-item writes. Creation retries only look up the original Host receipt. */
public enum PhoneWorkChange: Equatable, Sendable {
    /** The Host binds a discussion post to its originating device, item and original request. These IDs are ASCII. */
    static func postId(device: String, item: String, request: String) throws -> String {
        let identity = NativeJSON.array([.string("work-item-post-id"), .string(device), .string(item), .string(request)])
        return "pst_" + LinkBytes.base64url(LinkBytes.hash(try identity.encoded())).prefix(22)
    }
    case creation(title: String, prompt: String, project: String?)
    case completion(item: String, revision: UInt64, closed: Bool)
    case post(item: String, text: String, target: PhoneWorkPostTarget?)

    public var itemId: String? {
        switch self {
        case .creation: nil
        case let .completion(item, _, _), let .post(item, _, _): item
        }
    }
    public var pendingWords: String {
        switch self {
        case .creation: "保存待办结果待确认"
        case .completion: "待办状态结果待确认"
        case .post: "讨论发言结果待确认"
        }
    }
    public func request(requestId: String = UUID().uuidString) throws -> NativePendingWrite {
        switch self {
        case let .creation(rawTitle, rawPrompt, project):
            let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            let prompt = rawPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, title.unicodeScalars.count <= 120, title.rangeOfCharacter(from: .newlines) == nil,
                  prompt.utf16.count <= 16_000 else { throw NativeFailure.invalidRecord }
            var fields: [String: NativeJSON] = ["title": .string(title), "prompt": .string(prompt)]
            if let project {
                guard LinkBytes.matches(project, "[a-z0-9][a-z0-9_-]{0,63}") else { throw NativeFailure.invalidRecord }
                fields["projectId"] = .string(project)
            }
            return try NativePendingWrite(method: .post, path: "/link/api/work/items", fields: fields, requestId: requestId)
        case let .completion(item, revision, closed):
            guard PhoneWorkItems.validItem(item), revision <= LinkBytes.maximumInteger else { throw NativeFailure.invalidRecord }
            return try NativePendingWrite(method: .patch, path: "/link/api/work/items/" + item, fields: ["baseRevision": .number(Double(revision)), "closed": .bool(closed)], requestId: requestId)
        case let .post(item, raw, target):
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard PhoneWorkItems.validItem(item), !text.isEmpty, text.utf16.count <= 4000 else { throw NativeFailure.invalidRecord }
            var fields = ["text": NativeJSON.string(text)]
            if let target {
                guard PhoneWorkPostTarget(target.wire) == target else { throw NativeFailure.invalidRecord }
                fields["target"] = target.wire
            }
            return try NativePendingWrite(method: .post, path: "/link/api/work/items/" + item + "/posts", fields: fields, requestId: requestId)
        }
    }
    static func isCompletion(_ method: NativeHTTPMethod, _ path: String, _ fields: [String: NativeJSON]) -> Bool {
        method == .patch && LinkBytes.matches(path, "/link/api/work/items/itm_[A-Za-z0-9_-]{22}")
            && Set(fields.keys) == ["baseRevision", "closed"] && fields["baseRevision"]?.integer != nil
            && (fields["closed"] == .bool(true) || fields["closed"] == .bool(false))
    }
    public init?(_ request: NativePendingWrite) {
        guard let method = NativeHTTPMethod(rawValue: request.method),
              let fields = try? NativeJSON.decode(request.body) else { return nil }
        if method == .post, request.path == "/link/api/work/items", fields["requestId"].string == request.requestId,
           let title = fields["title"].string, let prompt = fields["prompt"].string,
           Set(fields.object.keys).isSubset(of: ["requestId", "title", "prompt", "projectId"]),
           fields.object["projectId"] == nil || fields["projectId"].string != nil {
            self = .creation(title: title, prompt: prompt, project: fields["projectId"].string)
            return
        }
        guard request.path.hasPrefix("/link/api/work/items/") else { return nil }
        let suffix = String(request.path.dropFirst("/link/api/work/items/".count))
        if Self.isCompletion(method, request.path, fields.object), let revision = fields["baseRevision"].integer {
            self = .completion(item: suffix, revision: revision, closed: fields["closed"].bool)
        } else {
            guard method == .post, suffix.hasSuffix("/posts") else { return nil }
            let item = String(suffix.dropLast("/posts".count))
            let target = PhoneWorkPostTarget(fields["target"])
            guard PhoneWorkItems.validItem(item), let text = fields["text"].string, fields["requestId"].string == request.requestId,
                  fields.object["target"] == nil || target != nil else { return nil }
            self = .post(item: item, text: text, target: target)
        }
    }
    public func confirmed(by value: NativeJSON, requestId: String) -> Bool {
        switch self {
        case .creation:
            guard value["requestId"].string == requestId, let id = value["item"]["id"].string else { return false }
            return (try? PhoneWorkItemDetail(value, itemId: id, privateAllowed: true)) != nil
        case let .completion(item, revision, closed):
            guard let result = try? PhoneWorkItemDetail(value, itemId: item, privateAllowed: true) else { return false }
            return result.item.revision > revision && result.closed == closed
        case let .post(_, text, target):
            let row = value["post"]
            guard let post = PhoneWorkPost(row), row["requestId"].string == requestId, post.text.utf8.elementsEqual(text.utf8) else { return false }
            if let target { return post.delivery != nil && (row["target"] == .null || post.target == target) }
            return post.delivery == nil && row["target"] == .null
        }
    }
}

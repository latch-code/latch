import Foundation

/** The OS can retain or redeliver a hint. Only a live Host response and the current decision drawer establish its target. */
public struct PhonePushHint: Equatable, Sendable {
    public let route: String
    public let ticket: String
    public let reject: Bool
    public init?(route: String, ticket: String, reject: Bool = false) {
        guard UUID(uuidString: route) != nil, LinkBytes.matches(ticket, "[0-9a-f]{32}") else { return nil }
        self.route = route; self.ticket = ticket; self.reject = reject
    }
}
public struct PhonePushTarget: Equatable, Sendable {
    public let session: String
    public let id: String
    public let approval: Bool
    public init?(_ value: NativeJSON) {
        guard let session = value["session"].string, PhoneComputers.listable(session),
              let id = value["id"].string, !id.isEmpty, id.utf8.count <= 256,
              let kind = value["kind"].string, kind == "approval" || kind == "question" else { return nil }
        self.session = session; self.id = id; self.approval = kind == "approval"
    }
    public func record(in detail: NativeJSON) -> NativeJSON? {
        guard detail["summary"]["id"].string == session else { return nil }
        return detail[approval ? "approvals" : "questions"].array.first {
            $0["id"].string == id && (!approval ? $0["state"].string == "pending" : true)
        }
    }
}

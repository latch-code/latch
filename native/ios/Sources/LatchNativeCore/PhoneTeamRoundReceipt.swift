import Foundation

/** Remembers which draft the person sent. A changed draft or a later opening never gets cleared by a late answer. */
public struct PhoneTeamRoundReceipt: Codable, Equatable, Sendable {
    public let session: String
    public let team: String
    public let opening: UUID
    let draftDigest: Data

    public init(session: String, team: String, opening: UUID, draft: String) throws {
        guard LinkBytes.matches(team, "tem_[A-Za-z0-9_-]{22}"), LinkBytes.matches(session, "[A-Za-z0-9_-]{1,160}") else {
            throw NativeFailure.invalidRecord
        }
        self.session = session; self.team = team; self.opening = opening
        draftDigest = LinkBytes.hash(Data(draft.utf8))
    }
    public func write(itemIds: [String], prompt: String) throws -> NativePendingWrite {
        guard (1...8).contains(itemIds.count), Set(itemIds).count == itemIds.count, itemIds.allSatisfy(PhoneWorkItems.validItem),
              !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, prompt.utf16.count <= 4_000 else { throw NativeFailure.invalidRecord }
        let sends = itemIds.map { NativeJSON.object(["itemId": .string($0), "prompt": .string(prompt)]) }
        return try NativePendingWrite(method: .post, path: "/link/api/teams/" + team + "/rounds", fields: ["sends": .array(sends)], teamRound: self)
    }
    func confirmed(by answer: NativeJSON) -> Bool {
        answer["team"]["id"].string == team && answer["team"]["leadSessionId"].string == session && (answer["team"]["round"].integer ?? 0) >= 2
    }
    @MainActor public func clearSentDraft(in drafts: PhoneConversationDrafts) {
        guard drafts.opening == opening else { return }
        let current = drafts.text(for: session, visible: true)
        if LinkBytes.hash(Data(current.utf8)) == draftDigest { _ = drafts.take(for: session, matching: current) }
    }
}

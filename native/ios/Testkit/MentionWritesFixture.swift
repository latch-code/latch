import Foundation
import LatchNativeCore

/** The Host took a round, but its original answer was malformed. An uncertain round remains available for inspection and cannot run a second time. */
@MainActor func teamRoundRetryFixture(_ workspace: NativeWorkspace, lead: String) async throws -> [String: Any] {
    let snapshot = try await workspace.snapshot()
    guard let team = PhoneMemberMentions(snapshot: snapshot, session: lead), team.members.count == 2 else { throw NativeFailure.invalidRecord }
    let draft = team.members.map(\.token).joined(separator: " ") + " Continue reviewing."
    guard let round = team.round(in: draft), round.reason == nil else { throw NativeFailure.invalidRecord }
    let drafts = PhoneConversationDrafts(), opening = drafts.opening
    drafts.set(draft, for: lead, opening: opening, permitted: true)
    let receipt = try PhoneTeamRoundReceipt(session: lead, team: team.teamId, opening: opening, draft: draft)
    let request = try receipt.write(itemIds: round.itemIds, prompt: round.prompt)
    do { _ = try await workspace.submit(request); throw NativeFailure.invalidRecord } catch NativeFailure.resultUnknown {}
    guard let saved = try await workspace.pendingWrites().first, saved.requestId == request.requestId, saved.body == request.body,
          saved.teamRound == receipt, !PhonePending.retried(saved, at: .session(lead)), !PhonePending.retried(saved, at: .list)
    else { throw NativeFailure.invalidRecord }
    drafts.set("Another draft", for: lead, opening: opening, permitted: true)
    do { _ = try await workspace.submit(saved, mustBePending: true); throw NativeFailure.invalidRecord } catch NativeFailure.resultUnknown {}
    let retained = try await workspace.pendingWrites().map(\.requestId) == [request.requestId]
    try await workspace.settlePending(request.requestId)
    receipt.clearSentDraft(in: drafts)
    guard drafts.text(for: lead, visible: true) == "Another draft" else { throw NativeFailure.invalidRecord }
    drafts.set(draft, for: lead, opening: opening, permitted: true)
    receipt.clearSentDraft(in: drafts)
    return ["retainedUntilReleased": retained, "clearedOriginal": drafts.text(for: lead, visible: true).isEmpty,
        "keptEditedDraft": true, "noPending": try await workspace.pendingWrites().isEmpty]
}

/** A delivery check reads the original post. It never starts a fresh turn in the Agent's chat. */
func workAgentRetryFixture(_ workspace: NativeWorkspace, agent: String, item: String) async throws -> [String: Any] {
    let checkpoint = try await workspace.listCheckpoint()
    let change = PhoneWorkChange.post(item: item, text: "Follow up from the phone.", target: .agent(agent))
    let request = try change.request()
    do { _ = try await workspace.submit(request, on: checkpoint.transport); throw NativeFailure.invalidRecord }
    catch NativeFailure.resultUnknown {}
    guard let saved = try await workspace.pendingWrites().first, saved.requestId == request.requestId,
          saved.body == request.body, PhoneWorkChange(saved) == change else { throw NativeFailure.invalidRecord }
    let answer = try await workspace.submit(saved, on: checkpoint.transport, mustBePending: true)
    let wrong = PhoneWorkChange.post(item: item, text: "Follow up from the phone.", target: .session("elsewhere"))
    return ["originalTarget": answer["post"]["target"]["customAgentId"].string == agent, "samePost": change.confirmed(by: answer, requestId: request.requestId),
        "wrongTargetRejected": !wrong.confirmed(by: answer, requestId: request.requestId), "noPending": try await workspace.pendingWrites().isEmpty]
}

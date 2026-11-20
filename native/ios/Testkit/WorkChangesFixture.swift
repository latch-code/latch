import Foundation
import LatchNativeCore

func workChangesFixture(_ workspace: NativeWorkspace, item: String, memberItem: String, session: String, denied: Bool) async throws -> [String: Any] {
    let transport = try await workspace.listCheckpoint().transport
    func read() async throws -> NativeJSON { try await workspace.readWork(.item(item), on: transport) }
    func unknown(_ request: NativePendingWrite, refusalStatus: Int) async throws -> NativePendingWrite {
        do { _ = try await workspace.submit(request, explain: true, on: transport); throw NativeFailure.invalidRecord }
        catch NativeFailure.resultUnknown { guard !denied else { throw NativeFailure.invalidRecord } }
        catch let response as NativeUnsettledRefusal { guard denied, response.refusal.status == refusalStatus else { throw response } }
        let pending = try await workspace.pendingWrites()
        guard pending.count == 1, let saved = pending.first, saved.requestId == request.requestId,
              saved.path == request.path, saved.method == request.method, saved.body == request.body else { throw NativeFailure.invalidRecord }
        return saved
    }
    let initial = try PhoneWorkItemDetail(await read(), itemId: item, privateAllowed: true)
    let close = PhoneWorkChange.completion(item: item, revision: initial.item.revision, closed: true)
    let original = try close.request()
    guard try NativeJSON.decode(original.body)["requestId"] == .null else { throw NativeFailure.invalidRecord }
    let savedClose = try await unknown(original, refusalStatus: 403)
    do { _ = try await workspace.submit(savedClose, explain: true, on: transport); throw NativeFailure.invalidRecord }
    catch let uncertain as NativeUnsettledRefusal { guard uncertain.refusal.code == "item-changed" else { throw uncertain } }
    let afterClose = try await read()
    guard close.confirmed(by: afterClose, requestId: savedClose.requestId),
          let nextRevision = afterClose["item"]["revision"].integer else { throw NativeFailure.invalidRecord }
    try await workspace.settlePending(savedClose.requestId)
    let reopen = PhoneWorkChange.completion(item: item, revision: nextRevision, closed: false)
    let reopened = try await workspace.submit(reopen.request(), on: transport)
    guard reopened["item"]["closedAt"] == .null, reopened["item"]["revision"].integer == initial.item.revision + 2 else { throw NativeFailure.invalidRecord }
    do { _ = try await workspace.submit(close.request(), explain: true, on: transport); throw NativeFailure.invalidRecord }
    catch let refusal as NativeHostRefusal { guard refusal.code == "item-changed" else { throw refusal } }

    let post = PhoneWorkChange.post(item: item, text: "Mobile discussion record", session: nil)
    let savedPost = try await unknown(post.request(), refusalStatus: 401)
    let repeated = try await workspace.submit(savedPost, on: transport)
    let memberPost = PhoneWorkChange.post(item: memberItem, text: "Mobile member delivery", session: session)
    let lostDelivery = try await unknown(memberPost.request(), refusalStatus: 404)
    let delivered = try await workspace.submit(lostDelivery, on: transport)
    let memberThread = try await workspace.readWork(.posts(memberItem, before: nil), on: transport)
    let thread = try await workspace.readWork(.posts(item, before: nil), on: transport)
    let settled = try await workspace.pendingWrites().isEmpty
    let postedOnce = thread["posts"].array.filter { $0["id"] == repeated["post"]["id"] }.count == 1
    let targeted = delivered["post"]["delivery"]["sessionId"].string == session && delivered["post"]["delivery"]["state"].string == "sent"
    _ = await workspace.closeOpening()
    return ["closeConfirmedAfterLostAnswer": true, "reopened": true, "staleRevisionRefused": true,
        "postRetriedOnce": postedOnce, "deliveredToMember": targeted, "settled": settled, "posts": [thread["posts"].array.count, memberThread["posts"].array.count]]
}

@MainActor func settledWorkWindowFixture(_ workspace: NativeWorkspace, vault: EncryptedVault, lease: BodyLease, item: String, markers: URL) async throws -> [String: Any] {
    func wait(_ ready: () -> Bool) async throws {
        for _ in 0..<250 {
            if ready() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw NativeFailure.unavailable
    }
    let transport = try await workspace.listCheckpoint().transport
    let original = try PhoneWorkItemDetail(await workspace.readWork(.item(item), on: transport), itemId: item, privateAllowed: true)
    let change = PhoneWorkChange.completion(item: item, revision: original.item.revision, closed: true)
    let request = try change.request()
    var privateState = PhonePrivateSnapshot()
    let oldWindow = privateState.epoch
    let changedBody = try PhoneWorkChange.completion(item: item, revision: original.item.revision, closed: false).request(requestId: request.requestId)
    guard privateState.mayRestorePending([request], captured: oldWindow, permitted: true, retry: request),
          !privateState.mayRestorePending([changedBody], captured: oldWindow, permitted: true, retry: request),
          !privateState.mayRestorePending([], captured: oldWindow, permitted: true, retry: request),
          !privateState.mayRestorePending([request], captured: oldWindow, permitted: false, retry: nil) else { throw NativeFailure.invalidRecord }
    privateState.clear()
    guard !privateState.mayRestorePending([request], captured: oldWindow, permitted: true, retry: request) else { throw NativeFailure.invalidRecord }

    let write = Task { try await workspace.submit(request, on: transport) }
    defer { write.cancel() }
    try await wait { FileManager.default.fileExists(atPath: markers.appendingPathComponent("response-ready").path) }
    let pause = FixtureVaultPause(), held = Task { await vault.fixturePause(pause) }
    defer { pause.release.signal() }
    try await wait { pause.hasEntered() }
    try Data().write(to: markers.appendingPathComponent("release-response"))
    try await wait { FileManager.default.fileExists(atPath: markers.appendingPathComponent("response-sent").path) }
    // A subsequent read on the same connection completes while the original reply is waiting for the vault.
    let saved = try await workspace.readWork(.item(item), on: transport)
    guard change.confirmed(by: saved, requestId: request.requestId) else { throw NativeFailure.invalidRecord }
    await workspace.invalidateContentWindow(lease)
    pause.release.signal()
    let heldUntilRelease = !(await held.value)
    let withdrawn: Bool
    do { _ = try await write.value; withdrawn = false } catch { withdrawn = error is CancellationError }
    _ = try await workspace.verify()
    let alreadySettled = try await workspace.pendingWrites().isEmpty
    var refused = false
    do { _ = try await workspace.submit(request, on: transport, mustBePending: true) }
    catch { refused = (error as? NativeFailure) == .changedElsewhere }
    var oldWindowRefused = false
    do { _ = try await workspace.submit(change.request(), on: transport, expectedLease: lease) }
    catch { oldWindowRefused = (error as? NativeFailure) == .expired }
    await workspace.closeOpening()
    return ["resultWithdrawn": withdrawn, "alreadySettled": alreadySettled, "retryRefused": refused,
        "blockedDuringSettlement": heldUntilRelease, "stalePendingWithdrawn": true, "oldWindowRefused": oldWindowRefused]
}

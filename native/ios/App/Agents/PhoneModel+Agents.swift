import Foundation
import LatchNativeCore

/** A read of an Agent's private parts: they sit behind the content window, and a smaller data scope cannot make it. */
enum PhoneAgentRead: Equatable {
    case loading, ready(NativeJSON), locked, confirming, offline, closed, missing, failed
}

/** What became of a memory write. The Host is the authority: nothing shows as saved until it says so. */
enum PhoneAgentWrite: Equatable {
    case done, unknown, changed, refused(String)
}

extension PhoneModel {
    func readAgentPart(_ path: String) async -> PhoneAgentRead {
        #if LATCH_SCREENS
        if staged { return ScreensStage.read(path) }
        #endif
        guard let workspace, connected else { return .offline }
        let current = generation
        do {
            try await ensureVerified()
            guard current == generation else { return .loading }
            let value = try await workspace.read(path, body: true)
            guard current == generation, verifiedUntil != nil else { return .closed }
            return .ready(value)
        } catch {
            guard current == generation else { return .loading }
            switch error as? NativeFailure {
            case .forbidden: return .locked
            case .resultUnknown: return .confirming
            case .expired, .declined, .notVerified: return .closed
            case .unsupported: return .missing
            case .unavailable: wentAway(error); return .offline
            default: return .failed
            }
        }
    }
    /** A phone gets 我的 Agent only inside a content window, so the tab opens one as a conversation does. */
    func openAgents() async {
        #if LATCH_SCREENS
        if staged { return }
        #endif
        guard workspace != nil, connected, verifiedUntil == nil, !verifying else { return }
        do { try await ensureVerified(); _ = await refresh() }
        catch { if (error as? NativeFailure) != .declined, !wentAway(error) { report(error) } }
    }
    var agentAccess: PhoneAgentAccess { PhoneAgents.access(snapshot, windowOpen: verifiedUntil != nil) }
    func readAgent(_ id: String) async -> PhoneAgentRead {
        guard PhoneAgents.validId(id) else { return .missing }
        return await readAgentPart("/link/api/custom-agents/" + id)
    }
    func readAutomation(_ id: String) async -> PhoneAgentRead {
        guard PhoneAgents.validAutomation(id) else { return .missing }
        return await readAgentPart("/link/api/automations/" + id)
    }
    /** Memory writes share the one unconfirmed write the phone keeps; a retry sends the same request. */
    func writeMemory(_ write: NativePendingWrite) async -> PhoneAgentWrite {
        #if LATCH_SCREENS
        if staged { return .done }
        #endif
        guard let workspace, !busy else { return .refused("稍后再试。") }
        guard canRun else { return .refused("这台设备不能修改记忆。") }
        let current = generation
        do {
            try await ensureVerified()
            guard current == generation else { return .refused("稍后再试。") }
            guard pending.allSatisfy({ $0.requestId == write.requestId }) else { return .refused("上一项提交结果待确认，先确认它。") }
            busy = true; defer { if generation == current { busy = false } }
            if !pending.contains(where: { $0.requestId == write.requestId }) { pending.append(write) }
            _ = try await workspace.submit(write)
            guard current == generation else { return .done }
            pending.removeAll { $0.requestId == write.requestId }
            _ = await refresh()
            return .done
        } catch {
            guard current == generation else { return .unknown }
            let failure = error as? NativeFailure
            if failure == .resultUnknown { return .unknown }
            pending.removeAll { $0.requestId == write.requestId }
            if failure == .changedElsewhere { return .changed }
            if failure == .expired { report(error) }
            return .refused(failure?.errorDescription ?? "没有保存，请重试。")
        }
    }
    /**
     * 委托: a real session of the Agent through the same start as 新会话, with the same request kept while its result is
     * unknown. On success the conversation opens in Code.
     */
    func delegate(agent: NativeJSON, choice: PhoneStartChoice, prompt: String) async -> Bool {
        let current = generation
        do {
            guard canRun, prompt.count <= 16_000 else { throw NativeFailure.forbidden }
            let fields = try PhoneAgents.fields(snapshot["catalog"], agent: agent, choice: choice, prompt: prompt)
            try await ensureVerified()
            guard current == generation else { return false }
            guard pending.isEmpty else { throw NativeFailure.resultUnknown }
            return await finishDelegation(try NativePendingWrite(method: .post, path: "/link/api/tasks", fields: fields))
        } catch { report(error); return false }
    }
    /** The first try, or a retry of the very same request. */
    func finishDelegation(_ write: NativePendingWrite) async -> Bool {
        sessionId = nil; detail = .null; contentGeneration = UUID()
        // True also when the result is unknown; the request then stays pending and the page offers it again.
        guard await submit(write), pending.isEmpty, sessionId != nil else { return false }
        tab = .code
        startEvents()
        return true
    }
    /** A session from 近期委托 opens as any conversation does, in Code. */
    func openFromAgent(_ id: String) async {
        tab = .code
        await openSession(id)
    }
}

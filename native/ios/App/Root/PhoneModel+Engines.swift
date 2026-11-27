import LatchNativeCore

/** A session's engine by the catalog. */
extension PhoneModel {
    func refreshHarnessModels(_ id: String, automatic: Bool, selectedModel: String? = nil) async throws {
        #if LATCH_SCREENS
        if staged { return }
        #endif
        let host = generation
        guard canRun else { throw NativeFailure.forbidden }
        if !automatic && !hasContentWindow { try await ensureVerified(whileCurrent: { !Task.isCancelled }) }
        guard host == generation, let workspace, let transport = installedTransport, transport.valid,
              let lease = bodyLease, lease.valid, !Task.isCancelled else { throw NativeFailure.unavailable }
        try await workspace.refreshHarnessModels(id, automatic: automatic, selectedModel: selectedModel)
        guard host == generation, installedTransport === transport, bodyLease?.sameWindow(as: lease) == true,
              !Task.isCancelled else { throw CancellationError() }
        _ = await refresh(includeSelectedBody: false)
    }
    func readHarnessCommands(_ id: String, fields: [String: NativeJSON]) async -> NativeJSON? {
        #if LATCH_SCREENS
        if staged { return nil }
        #endif
        guard let workspace, connected, hasScope("view") else { return nil }
        let current = generation, content = privateSnapshot.epoch
        let lease = await workspace.lease()
        guard current == generation, privateSnapshot.accepts(content), !Task.isCancelled,
              let lease, lease.valid else { return nil }
        guard let value = try? await workspace.harnessCommands(id, fields: fields),
              current == generation, privateSnapshot.accepts(content), !Task.isCancelled,
              lease.valid, verifiedUntil != nil else { return nil }
        return value["catalogue"] == .null ? nil : value["catalogue"]
    }
    func engineInfo(_ harnessId: String?) -> NativeJSON {
        snapshot["catalog"]["harnesses"].array.first { $0["id"].string == harnessId } ?? .null
    }
    func engineMark(_ harnessId: String?) -> String? {
        let info = engineInfo(harnessId)
        return info != .null ? PhoneStart.mark(info) : harnessId.map(PhoneStart.removedMark)
    }
    func engineName(_ harnessId: String?) -> String {
        let info = engineInfo(harnessId)
        if info != .null { return PhoneStart.engineName(info) }
        // A session keeps the identifier of an engine since removed, and should not read as if another ran it.
        return harnessId ?? "Harness"
    }
}

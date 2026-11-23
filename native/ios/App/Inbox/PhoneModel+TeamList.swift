import LatchNativeCore

extension PhoneModel {
    private var canReadTeamList: Bool {
        tab == .code && !workItemsShown && snapshot["device"]["status"].string == "active" && hasScope("view")
    }
    private var teamListTransport: NativeTransportEpoch? {
        canReadTeamList && snapshot["catalog"]["features"]["teams"].bool && transportReady ? installedTransport : nil
    }
    private func teamListReadMode(faceID: Bool) -> PhoneTeamListRead {
        PhoneUnlock.teamListRead(windowOpen: hasContentWindow, confirmed: privateSnapshot.confirmed, faceID: faceID)
    }
    /** The list can read its private projection silently if the window is already open or no owner prompt is required. */
    func teamListReadKey(faceID: Bool) -> NativeTransportEpoch? {
        guard !busy, !verifying, sessionId == nil || hasContentWindow,
              let transport = teamListTransport, teamListRead !== transport, teamListRetry !== transport,
              teamListReadMode(faceID: faceID) == .automatic else { return nil }
        return transport
    }

    func offersTeamListUnlock(faceID: Bool) -> Bool {
        guard !busy, !verifying, let transport = teamListTransport, teamListRead !== transport else { return false }
        let read = teamListReadMode(faceID: faceID)
        return read == .onRequest || (read == .automatic && teamListRetry === transport)
    }

    func loadTeamList(userInitiated: Bool = false) async {
        let faceID = PhoneFaceID.isOn
        guard let transport = teamListTransport,
              teamListReadKey(faceID: faceID) === transport || (userInitiated && offersTeamListUnlock(faceID: faceID)) else { return }
        let host = generation
        teamListRead = transport
        defer { if teamListRead === transport { teamListRead = nil } }
        func current() -> Bool { generation == host && teamListTransport === transport && !Task.isCancelled }
        do {
            if !hasContentWindow {
                guard userInitiated || !PhoneFaceID.isOn else { return }
                let opening = Task {
                    guard current(), userInitiated || !PhoneFaceID.isOn else { throw CancellationError() }
                    try await ensureVerified()
                }
                teamListOpening = (transport, opening)
                defer { if teamListOpening?.transport === transport { teamListOpening = nil } }
                try await opening.value
            }
            guard current(), hasContentWindow else { return }
            if !privateSnapshot.confirmed {
                // Request the same revision- and transport-checked snapshot used by an opened conversation.
                _ = await refresh(includeSelectedBody: false)
            }
            if current() { teamListRetry = hasContentWindow && privateSnapshot.confirmed ? nil : transport }
        } catch {
            guard current(), !(error is CancellationError) else { return }
            // A declined prompt or failed read retries only when the person chooses the list's control.
            teamListRetry = transport
            if (error as? NativeFailure) != .declined, !wentAway(error) { report(error) }
        }
    }
}

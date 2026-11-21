import LatchNativeCore

extension PhoneModel {
    private var teamListTransport: NativeTransportEpoch? {
        guard tab == .code, !workItemsShown, connected,
              snapshot["catalog"]["features"]["teams"].bool, snapshot["device"]["status"].string == "active",
              hasScope("view"), let transport = installedTransport, transport.valid else { return nil }
        return transport
    }

    /** The list can read its private projection silently if the window is already open or no owner prompt is required. */
    func teamListReadKey(faceID: Bool) -> NativeTransportEpoch? {
        guard !busy, !verifying, sessionId == nil || hasContentWindow,
              let transport = teamListTransport, teamListRead !== transport, teamListRetry !== transport,
              PhoneUnlock.teamListRead(windowOpen: hasContentWindow, confirmed: privateSnapshot.confirmed, faceID: faceID) == .automatic else { return nil }
        return transport
    }

    func offersTeamListUnlock(faceID: Bool) -> Bool {
        guard !busy, !verifying, let transport = teamListTransport, teamListRead !== transport else { return false }
        let read = PhoneUnlock.teamListRead(windowOpen: hasContentWindow, confirmed: privateSnapshot.confirmed, faceID: faceID)
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

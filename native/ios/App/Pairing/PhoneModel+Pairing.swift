import Foundation
import LatchNativeCore
import Network
import UIKit

/** What the pairing flow is showing. Errors use one sheet with one action. */
enum PhonePairingPhase: Equatable {
    case connecting, reconnecting, confirming(comparisonCode: String?)
    case connected(String)
    case failed(PhonePairingFailure)
}

enum PhonePairingFailure: Equatable {
    case unreachable, notNearby, localNetworkDenied, expired, contended, cancelled, timedOut, blocked, hostTooOld, pendingCompletion, unknown
    var title: String {
        switch self {
        case .unreachable: "连不上这台 Mac"
        case .notNearby: "当前网络未通过配对检查"
        case .localNetworkDenied: "需要“本地网络”权限"
        case .expired: "二维码已过期"
        case .contended: "这个二维码已被另一台设备使用"
        case .cancelled: "Mac 上取消了连接"
        case .timedOut: "Mac 上没有确认"
        case .blocked: "Mac 现在不能确认"
        case .hostTooOld: "请先更新 Mac 上的 Latch"
        case .pendingCompletion: "上一次配对的结果待确认"
        case .unknown: "连接没有完成"
        }
    }
    var message: String? {
        switch self {
        case .unreachable: "请确认两台设备能在局域网内互访，或用数据线连接并打开这台设备的个人热点，再扫一次。"
        case .notNearby: "已连上 Mac，但未能验证当前网络。如果两端在不同子网，请确认两端的 Latch 都已更新。也可以用数据线连接并打开个人热点，再扫一次。"
        case .localNetworkDenied: "在“设置”里允许 Latch 访问本地网络。"
        case .expired: "Mac 上会自动显示新的二维码，再扫一次。"
        case .contended: "为安全起见已取消。你可以在 Mac 的「设置 › 设备」中查看已连接的设备。"
        case .blocked: "Mac 上有完全访问的会话在运行，结束后再扫一次。"
        case .pendingCompletion: "请在上一次配对的 Mac 上显示新的二维码，再扫码用已保存的设备身份连接。"
        case .unknown: "再扫一次 Mac 上的二维码。"
        default: nil
        }
    }
}

extension PhoneModel {
    /** A scanned QR, from the scanner or a universal link. The same QR rescanned keeps its keys, so it is not contention. */
    func beginPairing(payload: String) async {
        await pairingCleanup?.value
        guard let store, pairingTask == nil else { return }
        #if LATCH_SCREENS
        PhoneLive.pairingCheckpoint(.accepted)
        #endif
        let current = generation
        do {
            let scanned = try PairingInvitation.parse(payload)
            let saved = await store.list()
            guard current == generation, self.store === store else { return }
            hosts = saved
            if await reconnectScannedHost(scanned, resumingDraft: draft?.payload == payload) { return }
            if let draft, draft.payload != payload {
                guard !hasPreparedDevice(draft.keys, in: saved) else {
                    pairing = .failed(.pendingCompletion); clearPastedPairing(); return
                }
                try await store.abandonDraft(); self.draft = nil
            }
            if draft == nil {
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.keysStarted)
                #endif
                let keys = try PhoneKeys.create(), next = PairingDraft(payload: payload, keys: keys, name: "Mac")
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.keysReady)
                #endif
                do { try await store.saveDraft(next) }
                catch { PhoneKeys.remove(keys); throw error }
                guard current == generation else { return }
                draft = next
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.draftSaved)
                #endif
            }
            resumePairing()
        } catch {
            guard current == generation else { return }
            pairing = .failed(failure(error, invitation: nil)); clearPastedPairing()
        }
    }
    /** Runs the pairing in the draft. An App restart comes back here by itself, and the Host hands the enrollment back. */
    func resumePairing(addresses: [PairingInvitation.Address]? = nil) {
        guard let draft, let store, pairingTask == nil else { return }
        pairing = .connecting; busy = true
        let current = generation
        pairingTask = Task {
            var owned: NativeHTTPConnection?
            var invitation: PairingInvitation?
            defer {
                if !Task.isCancelled || pairingTask?.isCancelled == true {
                    if generation == current { busy = false }
                    pairingTask = nil
                }
            }
            do {
                let parsed = try PairingInvitation.parseStored(draft.payload), keys = PhoneKeys.provider(draft.keys)
                invitation = parsed
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.dialStarted)
                #endif
                let (connection, address, gateway, allowComparison) = try await pairingTransport(parsed, addresses: addresses ?? parsed.lan)
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.dialReady)
                #endif
                owned = connection
                guard generation == current, !Task.isCancelled else { await connection.close(); return }
                pairingConnection = connection
                let flow = try NativePairing(invitation: parsed, keys: keys)
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.beginStarted)
                #endif
                var enrollment = try await flow.begin(on: connection, name: UIDevice.current.name, gatewayHash: gateway, allowComparison: allowComparison)
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.beginReady)
                #endif
                guard current == generation, !Task.isCancelled else {
                    if pairingConnection === connection || generation != current { await connection.close() }
                    return
                }
                pairing = .confirming(comparisonCode: enrollment.comparisonCode)
                for _ in 0..<300 {
                    try Task.checkCancellation()
                    if ["approved", "completed"].contains(enrollment.status) { break }
                    guard enrollment.status == "pending" else { break }
                    try await Task.sleep(for: .seconds(1))
                    guard let view = try await flow.status(on: connection) else { throw NativeFailure.unavailable }
                    enrollment = view
                }
                switch enrollment.status {
                case "approved", "completed": break
                case "denied", "cancelled": throw enrollment.contended ? NativePairingFailure.contended : NativePairingFailure.cancelled
                default: throw NativePairingFailure.timedOut
                }
                try Task.checkCancellation()
                pairing = .connecting
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.approved)
                #endif
                let device = try await flow.complete(on: connection) { device in
                    try await store.save(RegisteredHost(name: draft.name, device: device, keys: draft.keys, prepared: true))
                }
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.completeReady)
                #endif
                let name = Self.hostLabel(await flow.hostName)
                let saved = RegisteredHost(name: name, device: device, keys: draft.keys, prepared: false)
                try await store.save(saved); try await store.clearDraft(matching: draft.payload)
                guard current == generation, !Task.isCancelled else {
                    if pairingConnection === connection || generation != current { await connection.close() }
                    return
                }
                hosts = await store.list(); self.draft = nil
                rememberPairingAddress(address, invitation: parsed, host: saved)
                await connection.close(); pairingConnection = nil
                pairing = .connected(name)
                clearPastedPairing()
                try await Task.sleep(for: .seconds(1))
                guard current == generation else { return }
                pairing = nil; busy = false
                await connect(saved)
            } catch {
                #if LATCH_SCREENS
                PhoneLive.pairingCheckpoint(.failed)
                #endif
                // 取消 takes the connection over to tell the Host first, so an ordinary cancel and rescan is not contention.
                if generation != current || Task.isCancelled || error is CancellationError {
                    if pairingConnection === owned || generation != current { await owned?.close() }
                    return
                }
                let shown = failure(error, invitation: invitation)
                await owned?.close()
                if pairingConnection === owned { pairingConnection = nil }
                let shownNetworkDenied = shown == .unreachable ? await localNetworkDenied(invitation) : false
                guard generation == current, !Task.isCancelled else { return }
                await endPairing(shownNetworkDenied ? .localNetworkDenied : shown, keepDraft: shown == .unreachable, keys: draft.keys)
            }
        }
    }
    /** A pasted code is used once: the clipboard is cleared if nothing else was copied since. */
    func clearPastedPairing() {
        guard let pasted = pastedPairing else { return }
        pastedPairing = nil
        if UIPasteboard.general.changeCount == pasted { UIPasteboard.general.items = [] }
    }
    func cancelPairing() {
        let reconnecting = pairing == .reconnecting, connection = pairingConnection, task = pairingTask, store = store
        let hadDraft = !reconnecting && draft != nil, previousCleanup = pairingCleanup
        pairingTask = nil; pairingConnection = nil
        task?.cancel(); pairing = nil
        if !reconnecting { busy = false }
        if hadDraft { draft = nil }
        clearPastedPairing()
        pairingCleanup = Task {
            await previousCleanup?.value
            // Best effort: the Host's own 120 seconds end whatever this cannot reach.
            if let connection, let id = try? await connection.request(.get, path: "/link/api/native/pairing"),
               let value = try? NativeJSON.decode(id.body), let enrollment = value["enrollment"]["id"].string {
                _ = try? await connection.request(.delete, path: "/link/api/enrollments/\(enrollment)")
            }
            await connection?.close()
            await task?.value
            if hadDraft { try? await store?.abandonDraft() }
        }
        returnToSavedMac()
    }
    func dismissPairingFailure() { pairing = nil; returnToSavedMac() }
    /** A pairing resumed at launch took the place of connecting, and the list offers no other way to a lone saved Mac. */
    private func returnToSavedMac() {
        guard workspace == nil, !busy else { return }
        Task { await connectLast() }
    }
    private func endPairing(_ failure: PhonePairingFailure, keepDraft: Bool, keys: DeviceKeyReference?) async {
        if !keepDraft {
            if let keys, let store {
                hosts = await store.list()
                // A lost completion reply can outlive its QR. A new scan may authenticate this already registered identity.
                if hasPreparedDevice(keys, in: hosts), failure != .cancelled, failure != .contended {
                    pairing = .failed(.pendingCompletion); clearPastedPairing(); return
                }
                try? await store.discardPrepared(keys: keys)
                hosts = await store.list()
            }
            try? await store?.abandonDraft()
            draft = nil
        }
        pairing = .failed(failure)
        clearPastedPairing()
    }
    private func hasPreparedDevice(_ keys: DeviceKeyReference, in saved: [RegisteredHost]) -> Bool {
        saved.contains { $0.prepared && $0.keys.connectionTag == keys.connectionTag && $0.keys.verificationTag == keys.verificationTag }
    }
    private func failure(_ error: Error, invitation: PairingInvitation?) -> PhonePairingFailure {
        switch error as? NativePairingFailure {
        case .notNearby: return .notNearby
        case .unreachable: return invitation.map { $0.expiresAt <= Date() } == true ? .expired : .unreachable
        case .expired: return .expired
        case .contended: return .contended
        case .cancelled: return .cancelled
        case .timedOut: return .timedOut
        case .blocked: return .blocked
        case .hostTooOld: return .hostTooOld
        case nil: break
        }
        switch error as? NativeFailure {
        case .unavailable, .resultUnknown: return invitation.map { $0.expiresAt <= Date() } == true ? .expired : .unreachable
        default: return .unknown
        }
    }
    /** Either LAN endpoint from the QR. A wrong one costs one dial; a wrong Mac fails at the pinned root. */
    private func pairingTransport(_ invitation: PairingInvitation, addresses: [PairingInvitation.Address]) async throws -> (NativeHTTPConnection, PairingInvitation.Address, Data?, Bool) {
        let paths = await NativeDiscoveryWire.lanPaths() + (currentNetworkPath.map { [$0] } ?? [])
        #if LATCH_SCREENS
        PhoneLive.pairingCheckpoint(.lanReady)
        #endif
        for address in addresses {
            try Task.checkCancellation()
            let gateway = NativeDiscoveryWire.pairingGatewayHash(peer: address.host, paths: paths)
            let interface = NativeDiscoveryWire.directInterface(to: address.host, path: currentNetworkPath, allowRouted: gateway == nil)
            // A routed QR uses only an explicitly bound LAN path. The phone's own hotspot may have no default LAN path.
            guard interface != nil || gateway != nil else { continue }
            if let connection = try? await NativeHTTPConnection.open(host: address.host, port: address.port, rootSpki: invitation.rootSpki,
                    knockKey: invitation.knockKey, interface: interface) {
                return (connection, address, gateway, interface != nil)
            }
        }
        throw NativePairingFailure.unreachable
    }
    /** Asks the system why the LAN cannot be reached, without sending anything. */
    private func localNetworkDenied(_ invitation: PairingInvitation?) async -> Bool {
        guard let address = invitation?.lan.first, let port = NWEndpoint.Port(rawValue: address.port) else { return false }
        let probe = NWConnection(host: NWEndpoint.Host(address.host), port: port, using: .tcp)
        defer { probe.cancel() }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let once = PairingProbeOnce(continuation)
            probe.stateUpdateHandler = { state in
                switch state {
                case .waiting: once.finish(probe.currentPath?.unsatisfiedReason == .localNetworkDenied)
                case .ready, .failed, .cancelled: once.finish(false)
                default: break
                }
            }
            probe.start(queue: DispatchQueue(label: "app.latch.pairing-probe"))
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { once.finish(false) }
        }
    }
    /** The name the Mac reported, shown only after it passed the pinned root. Control characters never reach the screen. */
    private static func hostLabel(_ name: String?) -> String {
        var value = (name ?? "").replacingOccurrences(of: ".local", with: "")
        value.unicodeScalars.removeAll { $0.value < 32 || $0.value == 127 || (0x2000...0x206F).contains($0.value) && $0 != " " }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "我的 Mac" : String(trimmed.prefix(40))
    }
}

private final class PairingProbeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }
    func finish(_ value: Bool) {
        lock.lock(); let current = continuation; continuation = nil; lock.unlock()
        current?.resume(returning: value)
    }
}

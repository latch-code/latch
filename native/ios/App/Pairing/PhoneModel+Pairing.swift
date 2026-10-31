import Foundation
import LatchNativeCore
import Network
import UIKit

/** What the pairing flow is showing. Errors use one sheet with one action. */
enum PhonePairingPhase: Equatable {
    case connecting, confirming
    case connected(String)
    case failed(PhonePairingFailure)
}

enum PhonePairingFailure: Equatable {
    case unreachable, localNetworkDenied, expired, contended, cancelled, timedOut, blocked, hostTooOld, unknown
    var title: String {
        switch self {
        case .unreachable: "连不上这台 Mac"
        case .localNetworkDenied: "需要“本地网络”权限"
        case .expired: "二维码已过期"
        case .contended: "这个二维码已被另一台设备使用"
        case .cancelled: "Mac 上取消了连接"
        case .timedOut: "Mac 上没有确认"
        case .blocked: "Mac 现在不能确认"
        case .hostTooOld: "请先更新 Mac 上的 Latch"
        case .unknown: "连接没有完成"
        }
    }
    var message: String? {
        switch self {
        case .unreachable: "让 iPhone 和 Mac 连接同一个 Wi‑Fi，再扫一次。"
        case .localNetworkDenied: "在“设置”里允许 Latch 访问本地网络。"
        case .expired: "Mac 上会自动显示新的二维码，再扫一次。"
        case .contended: "为安全起见已取消。如果不是你，到 Mac 的“手机与设备”里移除陌生设备。"
        case .blocked: "Mac 上有完全访问的会话在运行，结束后再扫一次。"
        case .unknown: "再扫一次 Mac 上的二维码。"
        default: nil
        }
    }
}

extension PhoneModel {
    /** A scanned QR, from the scanner or a universal link. The same QR rescanned keeps its keys, so it is not contention. */
    func beginPairing(payload: String) async {
        guard let store, pairingTask == nil else { return }
        let current = generation
        do {
            _ = try PairingInvitation.parse(payload)
            if let draft, draft.payload != payload { try await store.abandonDraft(); self.draft = nil }
            if draft == nil {
                let keys = try SecureDeviceKeys.create(), next = PairingDraft(payload: payload, keys: keys, name: "Mac")
                do { try await store.saveDraft(next) }
                catch { SecureDeviceKeys.remove(keys); throw error }
                guard current == generation else { return }
                draft = next
            }
            resumePairing()
        } catch { await endPairing(failure(error, invitation: nil), keepDraft: false, keys: nil) }
    }
    /** Runs the pairing in the draft. An App restart comes back here by itself, and the Host hands the enrollment back. */
    func resumePairing() {
        guard let draft, let store, pairingTask == nil else { return }
        pairing = .connecting; busy = true
        let current = generation
        pairingTask = Task {
            var owned: NativeHTTPConnection?
            var invitation: PairingInvitation?
            defer { if generation == current { busy = false }; pairingTask = nil }
            do {
                let parsed = try PairingInvitation.parseStored(draft.payload), keys = SecureIdentityProvider(reference: draft.keys)
                invitation = parsed
                let (connection, peer) = try await pairingTransport(parsed)
                owned = connection
                guard generation == current, !Task.isCancelled else { await connection.close(); return }
                pairingConnection = connection
                let flow = try NativePairing(invitation: parsed, keys: keys)
                let paths = await NativeDiscoveryWire.lanPaths() + (currentNetworkPath.map { [$0] } ?? [])
                guard let gateway = NativeDiscoveryWire.pairingGatewayHash(peer: peer, paths: paths) else { throw NativePairingFailure.notNearby }
                var enrollment = try await flow.begin(on: connection, name: UIDevice.current.name, gatewayHash: gateway)
                guard current == generation, !Task.isCancelled else {
                    if pairingConnection === connection || generation != current { await connection.close() }
                    return
                }
                pairing = .confirming
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
                let device = try await flow.complete(on: connection) { device in
                    try await store.save(RegisteredHost(name: draft.name, device: device, keys: draft.keys, prepared: true))
                }
                let name = Self.hostLabel(await flow.hostName)
                let saved = RegisteredHost(name: name, device: device, keys: draft.keys, prepared: false)
                try await store.save(saved); try await store.clearDraft(matching: draft.payload)
                guard current == generation, !Task.isCancelled else {
                    if pairingConnection === connection || generation != current { await connection.close() }
                    return
                }
                hosts = await store.list(); self.draft = nil
                freshPairings[saved.id] = (parsed, networkGeneration)
                await connection.close(); pairingConnection = nil
                pairing = .connected(name)
                try await Task.sleep(for: .seconds(1))
                guard current == generation else { return }
                pairing = nil; busy = false
                await connect(saved)
            } catch {
                // 取消 takes the connection over to tell the Host first, so an ordinary cancel and rescan is not contention.
                if generation != current || error is CancellationError {
                    if pairingConnection === owned || generation != current { await owned?.close() }
                    return
                }
                let shown = failure(error, invitation: invitation)
                await owned?.close()
                if pairingConnection === owned { pairingConnection = nil }
                let shownNetworkDenied = shown == .unreachable ? await localNetworkDenied(invitation) : false
                await endPairing(shownNetworkDenied ? .localNetworkDenied : shown, keepDraft: shown == .unreachable, keys: draft.keys)
            }
        }
    }
    func cancelPairing() {
        let connection = pairingConnection, task = pairingTask, store = store
        pairingTask = nil; pairingConnection = nil
        task?.cancel(); pairing = nil; busy = false; draft = nil
        Task {
            // Best effort: the Host's own 120 seconds end whatever this cannot reach.
            if let connection, let id = try? await connection.request(.get, path: "/link/api/native/pairing"),
               let value = try? NativeJSON.decode(id.body), let enrollment = value["enrollment"]["id"].string {
                _ = try? await connection.request(.delete, path: "/link/api/enrollments/\(enrollment)")
            }
            await connection?.close()
            try? await store?.abandonDraft()
        }
    }
    func dismissPairingFailure() { pairing = nil }
    private func endPairing(_ failure: PhonePairingFailure, keepDraft: Bool, keys: DeviceKeyReference?) async {
        if !keepDraft {
            if let keys, let store {
                try? await store.discardPrepared(keys: keys)
                hosts = await store.list()
            }
            try? await store?.abandonDraft()
            draft = nil
        }
        pairing = .failed(failure)
    }
    private func failure(_ error: Error, invitation: PairingInvitation?) -> PhonePairingFailure {
        switch error as? NativePairingFailure {
        case .notNearby, .unreachable: return invitation.map { $0.expiresAt <= Date() } == true ? .expired : .unreachable
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
    private func pairingTransport(_ invitation: PairingInvitation) async throws -> (NativeHTTPConnection, String) {
        for address in invitation.lan {
            if let connection = try? await NativeHTTPConnection.open(host: address.host, port: address.port, rootSpki: invitation.rootSpki, knockKey: invitation.knockKey) {
                return (connection, address.host)
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

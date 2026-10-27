import Foundation
import LatchNativeCore
import UIKit

extension PhoneModel {
    func beginPairing(payload: String, name: String) async {
        guard let store, !busy else { return }
        busy = true; defer { if pairingTask == nil { busy = false } }
        let current = generation
        do {
            _ = try PairingInvitation.parse(payload)
            if draft != nil { throw NativeFailure.resultUnknown }
            let keys = try SecureDeviceKeys.create(), next = PairingDraft(payload: payload, keys: keys, name: name)
            do { try await store.saveDraft(next) }
            catch { SecureDeviceKeys.remove(keys); throw error }
            guard current == generation else { return }
            draft = next; busy = false; resumePairing()
        } catch { report(error) }
    }
    func resumePairing() {
        guard let draft, let store, pairingTask == nil else { return }
        error = nil; busy = true
        let current = generation
        pairingTask = Task {
            var owned: NativeHTTPConnection?
            defer { if generation == current { busy = false }; pairingTask = nil }
            do {
                let invitation = try PairingInvitation.parse(draft.payload), keys = SecureIdentityProvider(reference: draft.keys)
                let connection = try await pairingTransport(invitation)
                owned = connection
                guard generation == current, !Task.isCancelled else { await connection.close(); return }
                pairingConnection = connection
                let pairing = try NativePairing(invitation: invitation, keys: keys)
                let enrollment = try await pairing.begin(on: connection, name: UIDevice.current.name)
                guard current == generation, !Task.isCancelled else { await connection.close(); return }
                comparisonCode = enrollment.comparisonCode; status = "请在 Mac 输入这组六位码并确认"
                for _ in 0..<600 {
                    try Task.checkCancellation()
                    guard let view = try await pairing.status(on: connection) else { throw NativeFailure.unavailable }
                    if ["approved", "completed"].contains(view.status) {
                        let device = try await pairing.complete(on: connection) { device in
                            try await store.save(RegisteredHost(name: draft.name, device: device, keys: draft.keys, prepared: true))
                        }
                        let saved = RegisteredHost(name: draft.name, device: device, keys: draft.keys, prepared: false)
                        try await store.save(saved); try await store.clearDraft(matching: draft.payload)
                        guard current == generation, !Task.isCancelled else { await connection.close(); return }
                        hosts = await store.list(); self.draft = nil; comparisonCode = nil; status = "电脑已登记"
                        freshPairings[saved.id] = (invitation, networkGeneration)
                        await connection.close(); pairingConnection = nil
                        busy = false; await connect(saved)
                        return
                    }
                    guard view.status == "pending" else { throw NativeFailure.expired }
                    try await Task.sleep(for: .seconds(1))
                }
                throw NativeFailure.expired
            } catch {
                if generation != current || Task.isCancelled { await owned?.close(); return }
                comparisonCode = nil
                if (error as? NativeFailure) == .expired {
                    do {
                        try await store.abandonDraft()
                        if generation == current { self.draft = nil; comparisonCode = nil; self.error = "配对资料已过期，请重新扫描电脑上的二维码。" }
                    } catch { report(error) }
                } else { report(error) }
                await owned?.close()
                if pairingConnection === owned { pairingConnection = nil }
            }
        }
    }
    private func pairingTransport(_ invitation: PairingInvitation) async throws -> NativeHTTPConnection {
        let key = LinkBytes.hash(Data(invitation.invitation.utf8))
        for address in invitation.direct.prefix(2) {
            if let connection = try? await NativeHTTPConnection.open(host: address.host, port: address.port, rootSpki: invitation.rootSpki, knockKey: key) { return connection }
        }
        for relay in invitation.relays.prefix(2) {
            if let pass = relay.passes.first,
               let connection = try? await NativeHTTPConnection.relay(endpoint: relay, admission: pass, rootSpki: invitation.rootSpki, knockKey: key) { return connection }
        }
        throw NativeFailure.unavailable
    }
}

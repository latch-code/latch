import Foundation
import LatchNativeCore
import UIKit

extension PhoneModel {
    /**
     * Removes this phone from the Mac it is connected to. No Face ID: it only lowers privilege. Local keys and caches go
     * only on the Root-signed tombstone, which the next connection reads.
     */
    func disconnect(_ host: RegisteredHost) async -> Bool {
        guard selectedHost?.id == host.id, let workspace else { return false }
        await workspace.removeThisDevice()
        for attempt in 0..<4 {
            do { _ = try await paths.migrate(candidates(host), workspace: workspace) }
            catch {
                if let proof = await workspace.verifiedRevocation() {
                    await retire(host, proof: proof, removedHere: true)
                    return true
                }
            }
            try? await Task.sleep(for: .milliseconds(250 * (attempt + 1)))
        }
        return false
    }
    /** Enums and whole numbers only: no names, addresses, keys or session content. */
    func diagnostics() -> String {
        let info = Bundle.main.infoDictionary
        return [
            "Latch \(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))",
            "iOS \(UIDevice.current.systemVersion)",
            "macs \(hosts.count)",
            "connected \(connected)",
            "pairing \(draft != nil)",
            "contentWindow \(verifiedUntil != nil)",
        ].joined(separator: "\n")
    }
}

import Foundation
import LatchNativeCore

typealias RegisteredHost = NativeRegisteredHost
typealias PairingDraft = NativePairingDraft
typealias PhoneStore = NativeProfileStore

extension NativeProfileStore {
    static func open() async throws -> NativeProfileStore {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("LatchNative", isDirectory: true)
        return try await open(directory: directory, key: CacheKeychain.loadOrCreate(account: "primary"))
    }
}

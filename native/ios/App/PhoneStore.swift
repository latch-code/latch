import Foundation
import LatchNativeCore

typealias RegisteredHost = NativeRegisteredHost
typealias PairingDraft = NativePairingDraft
typealias PhoneStore = NativeProfileStore

extension NativeProfileStore {
    static func open() async throws -> NativeProfileStore {
        #if LATCH_SCREENS
        if PhoneLive.isOn { return try await open(directory: PhoneLive.storeDirectory, key: PhoneLive.storeKey, eraseKeys: { PhoneKeys.remove($0) }) }
        #endif
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("LatchNative", isDirectory: true)
        return try await open(directory: directory, key: CacheKeychain.loadOrCreate(account: "primary"))
    }
}

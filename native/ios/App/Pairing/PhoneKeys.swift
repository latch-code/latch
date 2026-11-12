import Foundation
import LatchNativeCore

/**
 * This device's keys. The product always uses the Secure Enclave; only the LatchScreens target, launched in live mode,
 * puts software keys in its place (`Screens/LiveKeys.swift`).
 */
enum PhoneKeys {
    static func create() throws -> DeviceKeyReference {
        #if LATCH_SCREENS
        if PhoneLive.isOn { return try LiveSoftwareKeys.create() }
        #endif
        return try SecureDeviceKeys.create()
    }
    static func remove(_ keys: DeviceKeyReference) {
        #if LATCH_SCREENS
        if PhoneLive.isOn { LiveSoftwareKeys.remove(keys); return }
        #endif
        SecureDeviceKeys.remove(keys)
    }
    static func provider(_ keys: DeviceKeyReference, askOwner: @escaping @Sendable () -> Bool = { false }) -> any NativeIdentityProvider {
        #if LATCH_SCREENS
        if PhoneLive.isOn { return LiveIdentityProvider(reference: keys) }
        #endif
        return SecureIdentityProvider(reference: keys, askOwner: askOwner)
    }
}

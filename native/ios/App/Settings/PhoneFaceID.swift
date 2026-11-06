import Foundation
import LocalAuthentication

/** Face ID before content: the person's own choice, off by default. One flag per phone; it holds nothing secret. */
enum PhoneFaceID {
    static let key = "app.latch.face-id-before-content"
    static var isOn: Bool { UserDefaults.standard.bool(forKey: key) }
    /** A phone without a passcode has nothing to ask with. */
    static var available: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }
    /** Either way asks once: on, to see that it works; off, so whoever holds the unlocked phone cannot just switch it off. */
    static func change(to value: Bool) async -> Bool {
        let context = LAContext()
        defer { context.invalidate() }
        if value || context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) {
            do {
                guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: value ? "查看会话前用 Face ID" : "查看会话前不再用 Face ID") else { return false }
            } catch { return false }
        }
        UserDefaults.standard.set(value, forKey: key)
        return true
    }
}

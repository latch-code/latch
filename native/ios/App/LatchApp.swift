import LatchNativeCore
import SwiftUI
import UIKit

// LatchScreens has its own entry with canned scenes; this one is the product's.
#if !LATCH_SCREENS
@main struct LatchApp: App {
    @StateObject private var model = PhoneModel()
    @Environment(\.scenePhase) private var phase
    @UIApplicationDelegateAdaptor(PhoneAppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup {
            PhoneRootView().environmentObject(model).tint(.blue)
                .task { await model.open() }
                .onChange(of: phase) { _, next in
                    Task { if next == .background { await model.lock() }; if next == .active { await model.open() } }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataWillBecomeUnavailableNotification)) { _ in
                    Task { await model.lock() }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
                    Task { await model.open() }
                }
        }
    }
}
#endif
final class PhoneAppDelegate: NSObject, UIApplicationDelegate {
    private var privacy: [UIWindow] = []
    func applicationWillResignActive(_ application: UIApplication) {
        privacy = application.connectedScenes.compactMap { scene in
            guard let scene = scene as? UIWindowScene, scene.activationState != .background else { return nil }
            let window = UIWindow(windowScene: scene), controller = UIViewController()
            controller.view.backgroundColor = .systemBackground
            window.rootViewController = controller; window.windowLevel = .alert + 1
            window.isUserInteractionEnabled = false; window.isHidden = false
            return window
        }
    }
    func applicationDidBecomeActive(_ application: UIApplication) {
        for window in privacy { window.isHidden = true }; privacy.removeAll()
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // The token is private input for the encrypted registration hook, never a notification body or log value.
        NotificationCenter.default.post(name: .latchPushToken, object: nil, userInfo: ["token": deviceToken])
    }
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        // Push is only a hint. No body is decrypted or write replayed while the App is closed.
        NotificationCenter.default.post(name: .latchStatusHint, object: nil)
        completionHandler(.noData)
    }
}
extension Notification.Name {
    static let latchPushToken = Notification.Name("app.latch.private-push-token")
    static let latchStatusHint = Notification.Name("app.latch.status-hint")
}

import Foundation

/** The App's own scheme, the same name whether it is read in the App or in its widget extension. Links carry only where to go. */
enum LatchLink {
    static var scheme: String {
        let id = Bundle.main.bundleIdentifier!
        return Bundle.main.bundleURL.pathExtension == "appex" ? id : id + ".questions"
    }
    /** 额度与用量, from the quota widgets. */
    static var quota: URL { URL(string: scheme + "://quota")! }
}

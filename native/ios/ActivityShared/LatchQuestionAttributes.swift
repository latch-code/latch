import ActivityKit
import Foundation

/** Neither the activity nor its link carries a computer, session, question, title, or answer. */
struct LatchQuestionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {}
    static var link: URL {
        let id = Bundle.main.bundleIdentifier!
        let scheme = Bundle.main.bundleURL.pathExtension == "appex" ? id : id + ".questions"
        return URL(string: scheme + "://pending")!
    }
}

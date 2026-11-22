import ActivityKit
import Foundation

/** Neither the activity nor its link carries a computer, session, question, title, or answer. */
struct LatchQuestionAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {}
    static var link: URL { URL(string: LatchLink.scheme + "://pending")! }
}

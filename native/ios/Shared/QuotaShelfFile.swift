import Foundation
import LatchNativeCore

/**
 * Where the App leaves the quota widgets' file (`PhoneQuotaWidget`): its App Group, named in Info.plist, so the screenshot
 * build keeps a container of its own. Nil without the group, as in a build that cannot carry it; the widgets then say so.
 */
enum QuotaShelfFile {
    /**
     * Quota figures are not private content: they carry no account or session, so the file is readable after the first
     * unlock and the Lock Screen widgets show them while the phone is locked.
     */
    static let writing: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]

    enum Reading { case missing, unreadable, shelf(NativeJSON) }

    static var url: URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "LatchAppGroup") as? String, group.hasPrefix("group."),
              let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return base.appendingPathComponent(PhoneQuotaWidget.fileName, isDirectory: false)
    }
    /** A file that is there but cannot be read is one the data protection keeps shut until the first unlock after a restart. */
    static func read() -> Reading {
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let data = try? Data(contentsOf: url, options: .uncached), let shelf = PhoneQuotaWidget.decode(data) else { return .unreadable }
        return .shelf(shelf)
    }
}

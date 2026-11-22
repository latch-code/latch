import Foundation
import LatchNativeCore
import WidgetKit

/**
 * Keeps the quota widgets' file. It is written as each live Host snapshot is adopted, only when what it says changes, and
 * removed with any computer and whenever another computer is chosen, so the widgets never show one Mac's figures as
 * another's. Which computer wrote it is known only within this run (it is not kept anywhere); with more than one computer
 * on the phone, a new run starts with no file rather than guess.
 */
@MainActor enum QuotaWidgetWriter {
    private static var written: NativeJSON?
    private static var writtenOffset: TimeInterval = 0
    private static var writtenFor: String?

    /** The computer the next snapshots come from. */
    static func connecting(to computer: String, computers: Int) {
        if writtenFor.map({ $0 != computer }) ?? (computers > 1) { forget() }
    }

    static func note(_ catalog: NativeJSON, computer: String, hostNow: Date, hostOffset: TimeInterval) {
        let shelf = PhoneQuotaWidget.shelf(catalog, now: hostNow)
        // Each clock reading moves by milliseconds; the file follows it only once it has moved by seconds.
        guard writtenFor != computer || shelf != written || abs(hostOffset - writtenOffset) > 5, let url = QuotaShelfFile.url,
              let data = try? PhoneQuotaWidget.encoded(shelf, hostOffset: hostOffset) else { return }
        do { try data.write(to: url, options: QuotaShelfFile.writing) } catch { return }
        written = shelf; writtenOffset = hostOffset; writtenFor = computer
        WidgetCenter.shared.reloadTimelines(ofKind: PhoneQuotaWidget.kind)
    }

    static func forget() {
        written = nil; writtenFor = nil
        guard let url = QuotaShelfFile.url, FileManager.default.fileExists(atPath: url.path) else { return }
        try? FileManager.default.removeItem(at: url)
        WidgetCenter.shared.reloadTimelines(ofKind: PhoneQuotaWidget.kind)
    }
}

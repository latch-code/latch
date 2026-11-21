import LatchNativeCore
import UIKit

/**
 * Pictures drawn in the conversation, by attachment, for the window they were read in. Memory only: no file is written,
 * and the whole set goes whenever the conversation's content is cleared (lock, background, removal, another computer).
 */
@MainActor enum PhonePictures {
    private static var images: [String: (lease: BodyLease, image: UIImage)] = [:]
    /** Oldest first: past `kept` pictures the oldest goes, to be read again if it scrolls back into view. */
    private static var order: [String] = []
    private static let kept = 32
    private static var loading: [String: Task<UIImage?, Never>] = [:]
    private static var active = 0
    #if LATCH_SCREENS
    static var staged: [String: UIImage] = [:]
    #endif
    static func clear() {
        for task in loading.values { task.cancel() }
        images = [:]; order = []; loading = [:]
    }
    fileprivate static func cached(_ id: String, lease: BodyLease) -> UIImage? {
        guard let hit = images[id], hit.lease.sameWindow(as: lease), hit.lease.valid else { return nil }
        return hit.image
    }
    fileprivate static func load(_ id: String, lease: BodyLease, workspace: NativeWorkspace) async -> UIImage? {
        if let running = loading[id] { return await running.value }
        let task = Task { @MainActor () -> UIImage? in
            // A few at a time: a long transcript of pictures must not queue every read at once.
            while active >= 3 { try? await Task.sleep(for: .milliseconds(60)); if Task.isCancelled { return nil } }
            active += 1; defer { active -= 1 }
            guard lease.valid, let image = try? await PreviewFiles.picture(attachment: id, lease: lease, workspace: workspace), lease.valid else { return nil }
            images[id] = (lease, image)
            order.removeAll { $0 == id }; order.append(id)
            while order.count > kept { images[order.removeFirst()] = nil }
            return image
        }
        loading[id] = task
        let image = await task.value
        if loading[id] == task { loading[id] = nil }
        return image
    }
}

extension PhoneModel {
    /** A drawn attachment, only while a content window is already open; nil leaves its tile as it is. */
    func picture(attachment id: String) async -> UIImage? {
        #if LATCH_SCREENS
        if staged { return PhonePictures.staged[id] }
        #endif
        guard hasContentWindow, let lease = bodyLease, lease.valid, let workspace else { return nil }
        if let hit = PhonePictures.cached(id, lease: lease) { return hit }
        return await PhonePictures.load(id, lease: lease, workspace: workspace)
    }
}

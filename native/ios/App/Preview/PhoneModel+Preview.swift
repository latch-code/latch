import Foundation
import LatchNativeCore

struct PhonePreviewProgress: Equatable { let completed: Int; let total: Int }

extension PhoneModel {
    func cancelPreview() { previewJob = nil; previewing = false; previewProgress = nil }
    func previewFailed(_ failure: Error) {
        guard !Task.isCancelled, !(failure is CancellationError) else { return }
        if [.expired, .forbidden, .contextChanged].contains(failure as? NativeFailure) { report(failure) }
        else { error = "此文件暂不能在手机预览。文本与 PNG/JPEG 可用；PDF、Office 和网页格式尚未完成 iOS 预览验证。" }
    }
    /** A file of the open session, or of `session` (a run's, from a result card or 资料库) under that session's file rules. */
    func preview(reference: String, root: String?, session: String? = nil, access: NativeFileAccess? = nil) async throws -> PreviewItem {
        guard !previewing, let workspace, let sessionId = session ?? sessionId else { throw NativeFailure.unavailable }
        let job = UUID(), current = generation, reading = contentGeneration
        previewJob = job; previewing = true; previewProgress = PhonePreviewProgress(completed: 0, total: 0)
        defer { if previewJob == job { cancelPreview() } }
        if let access {
            guard let bound = currentFileAccess, bound.transport === access.transport, bound.lease.sameWindow(as: access.lease) else { throw NativeFailure.contextChanged }
        } else { try await ensureVerified() }
        try Task.checkCancellation()
        guard generation == current, contentGeneration == reading, previewJob == job else { throw NativeFailure.contextChanged }
        let content = privateSnapshot.epoch
        let item: PreviewItem
        do {
            item = try await PreviewFiles.load(reference: reference, root: root, session: sessionId, workspace: workspace, access: access) { [weak self] done, total in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == current, self.contentGeneration == reading, self.privateSnapshot.accepts(content), self.previewJob == job else { return }
                    self.previewProgress = PhonePreviewProgress(completed: done, total: total)
                }
            }
        } catch {
            guard generation == current, contentGeneration == reading, privateSnapshot.accepts(content), previewJob == job else { throw CancellationError() }
            throw error
        }
        do {
            try Task.checkCancellation()
            guard generation == current, contentGeneration == reading, privateSnapshot.accepts(content), previewJob == job else { throw CancellationError() }
            try item.lease.requireValid()
            return item
        } catch { PreviewFiles.discard(item); throw error }
    }
}

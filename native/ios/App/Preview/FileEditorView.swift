import LatchNativeCore
import SwiftUI

/**
 * Plain-text editing of a small session file, full screen: 取消, the name and 保存. The save names the version that was
 * read (`baseHash`); when the file changed elsewhere nothing is written, and the person loads the latest or copies their
 * text. A save without an answer keeps its request for 重试保存.
 */
struct FileEditorView: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let name: String
    @State var edit: PreviewEdit
    let original: String
    let done: (PreviewItem?) -> Void
    @State private var text = ""
    @State private var base = ""
    @State private var conflict = false
    @State private var request: NativePendingWrite?
    @State private var unknown = false
    @State private var failure: String?
    @State private var askDiscard = false
    @State private var loading = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if conflict {
                    HStack(spacing: 8) {
                        Label("文件已在别处修改", systemImage: "exclamationmark.triangle").foregroundStyle(PhoneTheme.amber)
                        Spacer()
                        Button("复制我的修改") { LocalClipboard.copy(text) }
                        Button(loading ? "读取中…" : "载入最新") { Task { await loadLatest() } }.disabled(loading)
                    }.font(PhoneTheme.caption).padding(.horizontal, 16).padding(.vertical, 8).background(PhoneTheme.sunken)
                } else if unknown {
                    HStack {
                        Label("保存结果未知", systemImage: "questionmark.circle").foregroundStyle(PhoneTheme.amber)
                        Spacer()
                        Button("核对并放下") { Task { await checkAndDrop() } }.disabled(model.busy || !model.connected)
                        Button("重试保存") { Task { await save() } }.disabled(model.busy || !model.connected)
                    }.font(PhoneTheme.caption).padding(.horizontal, 16).padding(.vertical, 8).background(PhoneTheme.sunken)
                } else if let failure {
                    Text(failure).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).padding(.vertical, 8)
                }
                TextEditor(text: $text)
                    .font(.system(size: 13, design: .monospaced)).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .scrollContentBackground(.hidden).padding(.horizontal, 8).disabled(unknown)
            }
            .background(PhoneTheme.canvas)
            .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { if text != base && !unknown { askDiscard = true } else { close(nil) } } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.busy ? "保存中…" : "保存") { Task { await save() } }
                        .disabled(model.busy || conflict || unknown || text == base || !model.connected).keyboardShortcut("s", modifiers: .command)
                }
            }
            .confirmationDialog("放弃你的修改？", isPresented: $askDiscard, titleVisibility: .visible) {
                Button("放弃", role: .destructive) { close(nil) }
                Button("继续编辑", role: .cancel) {}
            }
        }
        .onAppear { text = original; base = original }
        .onChange(of: model.verifiedUntil) { _, value in if value == nil { close(nil) } }
        .interactiveDismissDisabled(text != base)
    }
    private func close(_ next: PreviewItem?) { done(next); dismiss() }
    private func save() async {
        if request == nil { request = try? PhoneFileEdit.save(sessionId: edit.sessionId, handle: edit.handle, baseHash: edit.baseHash, content: text) }
        guard let request else { failure = "这段内容不能保存"; return }
        failure = nil
        model.editPaths[request.requestId] = (edit.reference, edit.root)
        switch await model.write(request, retryAnswered: PhoneFileEdit.retryAnswered(request), refresh: false) {
        case .done:
            model.editPaths.removeValue(forKey: request.requestId)
            self.request = nil; unknown = false
            let next = try? await model.preview(reference: edit.reference, root: edit.root)
            close(next)
        case let .refused(refusal):
            model.editPaths.removeValue(forKey: request.requestId)
            self.request = nil; unknown = false
            if PhoneFileEdit.conflicted(refusal) { conflict = true } else { failure = PhoneFileEdit.refusalWords(refusal) }
        case .unknown: unknown = true
        case let .failed(error): model.editPaths.removeValue(forKey: request.requestId); self.request = nil; failure = (error as? NativeFailure)?.errorDescription ?? "没有保存"
        }
    }
    /** The handle may have expired: read the file again and say whether it holds this text, then let the save go. */
    private func checkAndDrop() async {
        guard let request else { return }
        // Not dropped: the request and its 重试保存 stay.
        guard let words = await model.checkAndDrop(request) else { failure = "没能核对，稍后再试"; return }
        self.request = nil; unknown = false; failure = words
    }
    /** The file as it is now, as the new base; what the person wrote is gone unless they copied it first. */
    private func loadLatest() async {
        loading = true; defer { loading = false }
        do {
            let item = try await model.preview(reference: edit.reference, root: edit.root)
            guard let next = item.edit, let latest = item.text else { failure = "这个文件现在不能编辑"; conflict = false; return }
            edit = next; text = latest; base = latest; conflict = false
        } catch { failure = "读不到这个文件" }
    }
}

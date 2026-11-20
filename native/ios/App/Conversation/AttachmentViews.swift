import LatchNativeCore
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/** A sent attachment in its message: tapping previews what Quick Look may show; other formats stay a label. */
struct SentAttachmentChip: View {
    let chip: PhoneAttachChip
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Image(systemName: chip.icon.symbol).font(.system(size: 12))
                Text(chip.name).lineLimit(1).truncationMode(.middle)
                Text(chip.size).foregroundStyle(PhoneTheme.faint)
            }
            .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
            .padding(.horizontal, 10).frame(height: 30)
            .background(PhoneTheme.raised, in: Capsule()).overlay(Capsule().stroke(PhoneTheme.line))
        }
        .buttonStyle(.plain).disabled(!chip.opens)
        .accessibilityLabel(chip.name + "，" + chip.size).accessibilityHint(chip.opens ? "预览" : "这种格式不能在手机预览")
    }
}

extension PhoneAttachIcon {
    /** The SF Symbol for this type: a picture, text, a PDF, a video, a sound, an archive or any other document. */
    var symbol: String {
        switch self {
        case .image: "photo"
        case .text: "doc.text"
        case .pdf: "doc.richtext"
        case .video: "film"
        case .audio: "waveform"
        case .archive: "doc.zipper"
        case .document: "doc"
        }
    }
}

/** Which picker the ＋ opened. */
enum AttachSource: String, Identifiable { case photos, camera, files; var id: String { rawValue } }

/** One input menu for attachments, commands and the options offered by this composer. */
struct ComposerMenu<Options: View>: View {
    @EnvironmentObject private var model: PhoneModel
    let key: String?
    let harness: NativeJSON
    let selection: NativeJSON?
    @Binding var source: AttachSource?
    @ViewBuilder let options: () -> Options

    var body: some View {
        Menu {
            if let key { Section { attachments(key) } }
            options()
        } label: { plus }
        .buttonStyle(.plain).accessibilityLabel("更多输入选项")
    }

    @ViewBuilder private func attachments(_ key: String) -> some View {
        if model.attachLocked(key) {
            Button("添加附件") { model.attachTrays[key, default: PhoneAttachTray()].note = PhoneAttachments.lockedWords }
        } else if model.tray(key).items.count >= PhoneAttachments.perMessage {
            Button("添加附件") { model.attachTrays[key]?.note = PhoneAttachments.tooMany }
        } else if let caps = model.attachState(key).caps, caps.any {
            if caps.takesImages {
                Button("照片", systemImage: "photo.on.rectangle") { source = .photos }
                if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("拍照", systemImage: "camera") { source = .camera } }
            }
            Button("文件", systemImage: "folder") { source = .files }
        } else {
            Button("添加附件") { model.explainAttach(key, harness: harness, selection: selection) }
        }
    }

    private var plus: some View {
        Image(systemName: "plus").font(.system(size: 15, weight: .semibold)).foregroundStyle(PhoneTheme.ink2)
            .frame(width: 36, height: 36).background(PhoneTheme.bubble, in: Circle())
            .frame(width: 44, height: 44).contentShape(Rectangle())
    }
}

/** The attachments waiting to go with the message, each with its own progress, retry and removal. */
struct AttachmentRows: View {
    @EnvironmentObject private var model: PhoneModel
    let key: String
    let selection: NativeJSON?
    /** Side inset: a full-width composer insets its rows; a sheet's padded column does not. */
    var inset: CGFloat = 12
    var body: some View {
        let tray = model.tray(key)
        VStack(alignment: .leading, spacing: 6) {
            if !tray.items.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) { ForEach(tray.items) { item in row(item) } }.padding(.horizontal, inset)
                }
            }
            if let note = tray.note {
                Text(note).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, inset + 4)
                    .onTapGesture { model.attachTrays[key]?.note = nil }
            }
        }
    }
    private func row(_ item: PhoneAttachDraft) -> some View {
        HStack(spacing: 8) {
            thumbnail(item)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.ink).lineLimit(1).truncationMode(.middle)
                status(item)
            }.frame(width: 120, alignment: .leading)
            trailing(item)
        }
        .padding(.leading, 6).padding(.trailing, 4).frame(height: 52)
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(borderColor(item)))
    }
    @ViewBuilder private func thumbnail(_ item: PhoneAttachDraft) -> some View {
        if item.kind == .image, let preview = item.thumbnail, let image = UIImage(data: preview) {
            Image(uiImage: image).resizable().scaledToFill().frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
        } else {
            Image(systemName: item.icon.symbol).font(.system(size: 16)).foregroundStyle(PhoneTheme.muted).frame(width: 40, height: 40)
                .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
        }
    }
    @ViewBuilder private func status(_ item: PhoneAttachDraft) -> some View {
        switch item.status {
        case .preparing: Text("准备中…").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
        case let .uploading(done):
            ProgressView(value: done).tint(PhoneTheme.accent).frame(height: 4).accessibilityLabel("正在上传")
        case .ready: Text(PhoneAttachments.sizeText(item.size)).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
        case .unknown: Label("结果未知", systemImage: "clock").font(.system(size: 12)).foregroundStyle(PhoneTheme.amber).lineLimit(1)
        case let .failed(words): Text(words).font(.system(size: 12)).foregroundStyle(PhoneTheme.amber).lineLimit(2)
        case let .refused(words): Text(words).font(.system(size: 12)).foregroundStyle(PhoneTheme.red).lineLimit(2)
        case let .confirm(words): Text(words).font(.system(size: 12)).foregroundStyle(PhoneTheme.amber).lineLimit(2)
        }
    }
    /** Refused rows offer only 移除; 结果未知 and other failures offer 重试 with the same request. */
    @ViewBuilder private func trailing(_ item: PhoneAttachDraft) -> some View {
        // A row its message is being sent with, or an unconfirmed write carries, stays as it is: no retry, cancel or removal.
        if !model.attachLocked(key) { controls(item) }
    }
    @ViewBuilder private func controls(_ item: PhoneAttachDraft) -> some View {
        HStack(spacing: 2) {
            switch item.status {
            case .uploading:
                Button { Task { await model.cancelUpload(item.id) } } label: { icon("stop.circle") }.accessibilityLabel("取消上传")
            case .failed, .unknown:
                if let selection { Button { model.startUpload(key, id: item.id, selection: selection) } label: { icon("arrow.clockwise") }.accessibilityLabel("重试") }
            case .confirm:
                if let selection { Button("仍然添加") { model.startUpload(key, id: item.id, selection: selection, acknowledge: true) }.font(.system(size: 12, weight: .medium)) }
            default: EmptyView()
            }
            if !isUploading(item) { Button { model.removeAttachment(key, id: item.id) } label: { icon("xmark") }.accessibilityLabel("移除") }
        }.buttonStyle(.plain)
    }
    private func isUploading(_ item: PhoneAttachDraft) -> Bool { if case .uploading = item.status { true } else { false } }
    private func icon(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 13, weight: .semibold)).foregroundStyle(PhoneTheme.muted).frame(width: 30, height: 30).contentShape(Rectangle())
    }
    private func borderColor(_ item: PhoneAttachDraft) -> Color {
        switch item.status {
        case .refused: PhoneTheme.red
        case .unknown, .failed, .confirm: PhoneTheme.amber
        default: PhoneTheme.line
        }
    }
}

/** The pickers. Photos need no library permission; files come as this App's own copy, moved into the stage and read once. */
struct AttachPicker: View {
    let source: AttachSource
    /** Images are re-encoded under this; other files above `largest` are not read. */
    let imageLimit: Int
    let largest: Int
    /** The Host takes any file for this Harness; otherwise the file picker offers images and text only. */
    let files: Bool
    let remaining: Int
    let done: @MainActor (PhoneAttachPick, [PhonePicked]) -> Void
    @State private var delivery = PickDelivery()
    var body: some View {
        Group {
            switch source {
            case .photos: PhotoPicker(limit: imageLimit, remaining: remaining, done: deliver).ignoresSafeArea()
            case .camera: CameraPicker(limit: imageLimit, done: deliver).ignoresSafeArea()
            case .files: FilePicker(imageLimit: imageLimit, largest: largest, files: files, remaining: remaining, done: deliver).ignoresSafeArea()
            }
        }
        // A picker that went away without answering (the document picker dismisses itself first) still says so.
        .onDisappear { let delivery = delivery, done = done; Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            if !delivery.answered { done(.lost, []) }
        } }
    }
    private var deliver: @MainActor @Sendable ([PhonePicked]?) -> Void {
        let delivery = delivery, done = done
        return { picked in
            // A second answer adds nothing: what it staged goes at once.
            guard delivery.take() else { for item in picked ?? [] { PhoneAttachStage.remove(item.file) }; return }
            if let picked { done(.files(picked.count), picked) } else { done(.cancelled, []) }
        }
    }
}

/** One answer per picker. The lost-picker note does not take it: a late callback still adds its files and clears the note. */
@MainActor final class PickDelivery {
    private(set) var answered = false
    func take() -> Bool { if answered { return false }; answered = true; return true }
}

private struct PhotoPicker: UIViewControllerRepresentable {
    let limit: Int
    let remaining: Int
    let done: @MainActor @Sendable ([PhonePicked]?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> PHPickerViewController {
        // No library permission: the picker runs outside this App and hands over only what is chosen.
        var configuration = PHPickerConfiguration()
        configuration.filter = .images; configuration.selectionLimit = max(1, remaining); configuration.preferredAssetRepresentationMode = .compatible
        let controller = PHPickerViewController(configuration: configuration); controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: PhotoPicker
        /** Held until it answers: SwiftUI may drop the representable before a self-dismissing picker calls back. */
        private var hold: Coordinator?
        init(_ parent: PhotoPicker) { self.parent = parent; super.init(); hold = self }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            let limit = parent.limit, done = parent.done
            hold = nil
            if results.isEmpty { done(nil); return }
            Task {
                var picked: [PhonePicked] = []
                for (index, result) in results.prefix(PhoneAttachments.perMessage).enumerated() {
                    let name = result.itemProvider.suggestedName ?? "照片 \(index + 1)"
                    picked.append(await Self.load(result.itemProvider, name: name, limit: limit))
                }
                await done(picked)
            }
        }
        private static func load(_ provider: NSItemProvider, name: String, limit: Int) async -> PhonePicked {
            await withCheckedContinuation { continuation in
                // The provider's file exists only during this callback; it is re-encoded here and never kept.
                _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                    guard let url else { continuation.resume(returning: PhonePicked(name: name, kind: .image, file: nil, size: 1, failure: PhoneAttachLoader.unreadable)); return }
                    continuation.resume(returning: PhoneAttachLoader.image(url: url, name: name, limit: limit))
                }
            }
        }
    }
}

private struct FilePicker: UIViewControllerRepresentable {
    let imageLimit: Int
    let largest: Int
    let files: Bool
    let remaining: Int
    let done: @MainActor @Sendable ([PhonePicked]?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        // A copy into this App's own sandbox: no lasting access to the original.
        let controller = UIDocumentPickerViewController(forOpeningContentTypes: files ? [.data] : [.image, .text], asCopy: true)
        controller.allowsMultipleSelection = remaining > 1; controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let parent: FilePicker
        /** Held until it answers: SwiftUI may drop the representable before a self-dismissing picker calls back. */
        private var hold: Coordinator?
        init(_ parent: FilePicker) { self.parent = parent; super.init(); hold = self }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            let imageLimit = parent.imageLimit, largest = parent.largest, done = parent.done
            hold = nil
            Task.detached {
                var picked: [PhonePicked] = []
                for (index, url) in urls.enumerated() {
                    if index < PhoneAttachments.perMessage { picked.append(PhoneAttachLoader.file(url: url, imageLimit: imageLimit, largest: largest)) }
                    else { try? FileManager.default.removeItem(at: url) }
                }
                await done(picked)
            }
        }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { parent.done(nil); hold = nil }
    }
}

private struct CameraPicker: UIViewControllerRepresentable {
    let limit: Int
    let done: @MainActor @Sendable ([PhonePicked]?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController(); controller.sourceType = .camera; controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        /** Held until it answers: SwiftUI may drop the representable before a self-dismissing picker calls back. */
        private var hold: Coordinator?
        init(_ parent: CameraPicker) { self.parent = parent; super.init(); hold = self }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            let limit = parent.limit, done = parent.done
            hold = nil
            let original = (info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.95)
            Task.detached {
                // The photo's metadata dictionary is never read; only its pixels are re-encoded.
                let picked = PhoneAttachLoader.camera(original, limit: limit)
                await done([picked])
            }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.done(nil); hold = nil }
    }
}

/** What every composer with a ＋ needs: what may be attached, read again as it changes, and the picker it opens. */
struct AttachSupport: ViewModifier {
    @EnvironmentObject private var model: PhoneModel
    /** Nil where this composer takes no attachments. */
    let key: String?
    let selection: NativeJSON?
    let harness: NativeJSON
    @Binding var source: AttachSource?
    func body(content: Content) -> some View {
        content
            // Read again when the selection changes, or the Harness starts or reports what it takes, as the web does.
            .task(id: revision) { if let key { await model.loadAttachCaps(key, selection: selection, harness: harness) } }
            .sheet(item: $source) { source in
                let caps = key.flatMap { model.attachState($0).caps }, count = key.map { model.tray($0).items.count } ?? 0
                AttachPicker(source: source, imageLimit: caps.map { PhoneAttachments.limit(.image, $0) } ?? PhoneAttachments.streamBytes,
                    largest: caps.map { PhoneAttachments.limit($0.files ? .file : .text, $0) } ?? 0, files: caps?.files == true,
                    remaining: PhoneAttachments.perMessage - count) { pick, picked in
                    // The rows first, then the sheet goes: a pick never depends on the sheet still being there.
                    if let key { model.addAttachments(key, pick: pick, picked: picked, selection: selection) }
                    self.source = nil
                }
            }
    }
    private var revision: String {
        let selected = (try? selection?.encoded()).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return [key ?? "", selected, PhoneAttachments.revision(harness), model.verifiedUntil == nil ? "closed" : "open", model.connected ? "on" : "off"].joined(separator: "|")
    }
}

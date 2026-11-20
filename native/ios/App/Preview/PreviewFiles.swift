import Foundation
import ImageIO
import LatchNativeCore
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct PreviewItem: Identifiable {
    let id = UUID()
    let name: String
    let text: String?
    let url: URL?
    let lease: BodyLease
    /** A text file the Host offers to edit, with the version this read fixed. */
    var edit: PreviewEdit? = nil
}

struct PreviewEdit: Equatable {
    let sessionId: String
    let handle: String
    let baseHash: String
    let reference: String
    let root: String?
}

@MainActor enum PreviewFiles {
    private static var temporary: [URL] = []
    static func clear() {
        for url in temporary { try? FileManager.default.removeItem(at: url) }
        temporary.removeAll()
    }
    static func discard(_ item: PreviewItem) {
        guard let folder = item.url?.deletingLastPathComponent(), temporary.contains(folder) else { return }
        try? FileManager.default.removeItem(at: folder); temporary.removeAll { $0 == folder }
    }
    static func purgeAbandoned() {
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey]
        guard let entries = FileManager.default.enumerator(at: FileManager.default.temporaryDirectory,
            includingPropertiesForKeys: keys, options: [.skipsSubdirectoryDescendants, .skipsHiddenFiles]) else { return }
        for _ in 0..<2000 {
            guard let url = entries.nextObject() as? URL else { break }
            let name = url.lastPathComponent
            guard name.hasPrefix("latch-preview-"), UUID(uuidString: String(name.dropFirst(14))) != nil,
                  let values = try? url.resourceValues(forKeys: Set(keys)), values.isDirectory == true, values.isSymbolicLink != true else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }
    /** The root a sent attachment's chip opens with; no folder ID has this shape. */
    static let attachmentRoot = "@attachment"
    static func load(reference: String, root: String?, session: String, workspace: NativeWorkspace, access: NativeFileAccess? = nil, progress: (@Sendable (Int, Int) -> Void)? = nil) async throws -> PreviewItem {
        guard let lease = await workspace.lease() else { throw NativeFailure.expired }
        if let access {
            guard root != attachmentRoot, access.transport.valid, access.lease.sameWindow(as: lease) else { throw NativeFailure.contextChanged }
            try access.lease.requireValid()
        }
        if root == attachmentRoot {
            // A message's own attachment: a short-lived handle bound to this device, read through the same bounded ranges.
            let meta = try await workspace.resolveAttachment(reference)
            guard meta["source"].string == "attachment", meta["attachmentId"].string == reference else { throw NativeFailure.unsupported }
            return try await load(meta: meta, lease: lease, reference: reference, root: nil, session: session, workspace: workspace, attachment: true, progress: progress)
        }
        let resolved = try await workspace.resolveFile(sessionId: session, reference: reference, rootId: root, access: access)
        guard let entry = resolved["files"].array.first, entry["status"].string == "ok" else { throw NativeFailure.unsupported }
        return try await load(meta: entry["file"], lease: lease, reference: reference, root: root, session: session, workspace: workspace, attachment: false, access: access, progress: progress)
    }
    private static func load(meta: NativeJSON, lease: BodyLease, reference: String, root: String?, session: String, workspace: NativeWorkspace,
        attachment: Bool, access: NativeFileAccess? = nil, progress: (@Sendable (Int, Int) -> Void)?) async throws -> PreviewItem {
        guard !meta["secret"].bool, meta["actions"]["preview"].bool,
              let handle = meta["handle"].string, let etag = meta["etag"].string, let kind = meta["kind"].string,
              let name = meta["name"].string, let size = meta["size"].integer, size <= 8_388_608 else { throw NativeFailure.unsupported }
        let text = ["text", "code", "markdown", "csv"].contains(kind)
        let raster = kind == "image" && ["image/png", "image/jpeg"].contains(meta["mime"].string ?? "")
        guard text || raster, !text || size <= 524_288 else { throw NativeFailure.unsupported }
        var data = Data()
        progress?(0, Int(size))
        while data.count < size {
            try Task.checkCancellation(); try lease.requireValid()
            let offset = data.count, total = Int(size), count = min(1_048_576, total - offset)
            data.append(try await workspace.fileBytes(handle: handle, etag: etag, offset: offset, count: count, explicitOpen: true, attachment: attachment, access: access) { done, _ in progress?(offset + done, total) })
        }
        try Task.checkCancellation(); try lease.requireValid()
        if text {
            guard let value = String(data: data, encoding: .utf8) else { throw NativeFailure.unsupported }
            let edit = !attachment && PhoneFileEdit.offered(meta, canRun: true, wholeText: data.count == Int(size), text: value)
                ? PreviewEdit(sessionId: session, handle: handle, baseHash: PhoneFileEdit.baseHash(data), reference: reference, root: root) : nil
            return PreviewItem(name: name, text: value, url: nil, lease: lease, edit: edit)
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary), CGImageSourceGetCount(source) > 0,
              let actualType = CGImageSourceGetType(source) as String?, [UTType.png.identifier, UTType.jpeg.identifier].contains(actualType),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0, width.doubleValue <= 100_000, height.doubleValue <= 100_000,
              width.doubleValue * height.doubleValue <= 100_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 4096, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              let png = UIImage(cgImage: image).pngData(), png.count <= 8_388_608 else { throw NativeFailure.unsupported }
        try lease.requireValid()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("latch-preview-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        let url = folder.appendingPathComponent("preview.png")
        do {
            try png.write(to: url, options: [.atomic, .completeFileProtection])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            try lease.requireValid(); temporary.append(folder)
            return PreviewItem(name: name, text: nil, url: url, lease: lease)
        } catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
}

struct NativePreviewView: View {
    @EnvironmentObject private var model: PhoneModel
    @State var item: PreviewItem
    @Environment(\.dismiss) private var dismiss
    @State private var editing = false
    @State private var saved = false
    var body: some View {
        NavigationStack {
            Group {
                if !item.lease.valid { ContentUnavailableView("内容已收起", systemImage: "lock", description: Text("关闭预览后再打开一次。")) }
                else if let text = item.text { ScrollView { ConversationText(text: text, monospaced: true).padding().frame(maxWidth: .infinity, alignment: .leading) } }
                else if item.url != nil { RasterQuickLook(item: item) }
            }
            .navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                if let edit = item.edit, item.text != nil, model.canRun, item.lease.valid {
                    let running = ["running", "waiting-approval"].contains(model.summary(of: edit.sessionId)["status"].string ?? "")
                    ToolbarItem(placement: .topBarLeading) {
                        Button(saved ? "已保存" : "编辑") { editing = true }.disabled(running || saved)
                            .accessibilityLabel(running ? "Agent 运行中，不能编辑" : "编辑")
                    }
                }
            }
            .fullScreenCover(isPresented: $editing) {
                if let edit = item.edit, let text = item.text {
                    FileEditorView(name: item.name, edit: edit, original: text) { next in
                        if let next { item = next; saved = true; Task { try? await Task.sleep(for: .seconds(2)); saved = false } }
                    }
                }
            }
        }
        .onChange(of: model.privateSnapshot.epoch) { _, _ in editing = false; dismiss() }
    }
}
private struct RasterQuickLook: UIViewControllerRepresentable {
    let item: PreviewItem
    func makeCoordinator() -> Coordinator { Coordinator(item) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) { if !item.lease.valid { controller.dismiss(animated: false) } }
    final class Coordinator: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
        let item: PreviewItem
        init(_ item: PreviewItem) { self.item = item }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { item.lease.valid && item.url != nil ? 1 : 0 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            (item.lease.valid ? item.url : nil) as NSURL? ?? NSURL(fileURLWithPath: "/nonexistent-latch-preview")
        }
        nonisolated func previewController(_ controller: QLPreviewController, shouldOpen url: URL, for item: any QLPreviewItem) -> Bool { false }
    }
}

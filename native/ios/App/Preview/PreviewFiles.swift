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
    static func load(reference: String, root: String?, session: String, workspace: NativeWorkspace, progress: (@Sendable (Int, Int) -> Void)? = nil) async throws -> PreviewItem {
        guard let lease = await workspace.lease() else { throw NativeFailure.expired }
        let resolved = try await workspace.resolveFile(sessionId: session, reference: reference, rootId: root)
        guard let entry = resolved["files"].array.first, entry["status"].string == "ok" else { throw NativeFailure.unsupported }
        let meta = entry["file"]
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
            data.append(try await workspace.fileBytes(handle: handle, etag: etag, offset: offset, count: count, explicitOpen: true) { done, _ in progress?(offset + done, total) })
        }
        try Task.checkCancellation(); try lease.requireValid()
        if text {
            guard let value = String(data: data, encoding: .utf8) else { throw NativeFailure.unsupported }
            return PreviewItem(name: name, text: value, url: nil, lease: lease)
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
    let item: PreviewItem
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Group {
                if !item.lease.valid { ContentUnavailableView("内容已收起", systemImage: "lock", description: Text("关闭预览后再打开一次。")) }
                else if let text = item.text { ScrollView { ConversationText(text: text, monospaced: true).padding().frame(maxWidth: .infinity, alignment: .leading) } }
                else if item.url != nil { RasterQuickLook(item: item) }
            }
            .navigationTitle(item.name).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
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

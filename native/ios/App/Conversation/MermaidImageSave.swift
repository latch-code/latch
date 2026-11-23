import LatchNativeCore
import UIKit

/** No bytes are written until Files returns the folder the reader chose for this exact diagram and window. */
struct MermaidImageSave: Identifiable {
    let id = UUID()
    let image: UIImage
    let lease: BodyLease?
    private let host: UUID
    private let reading: UUID
    private let session: String?

    @MainActor init(image: UIImage, model: PhoneModel) {
        self.image = image
        host = model.generation
        reading = model.contentGeneration
        session = model.sessionId
        lease = model.bodyLease
    }

    @MainActor func matches(_ model: PhoneModel) -> Bool {
        guard model.hasContentWindow, host == model.generation, reading == model.contentGeneration, session == model.sessionId else { return false }
        if let lease, let current = model.bodyLease { return lease.valid && current.sameWindow(as: lease) }
        // Only the simulator's staged window can be open without a transport lease.
        return lease == nil && model.bodyLease == nil
    }
}

actor MermaidImageWriter {
    static let shared = MermaidImageWriter()

    func save(_ request: MermaidImageSave, in folder: URL) throws -> String {
        guard folder.isFileURL, folder.startAccessingSecurityScopedResource() else { throw CocoaError(.fileWriteNoPermission) }
        defer { folder.stopAccessingSecurityScopedResource() }
        try Task.checkCancellation()
        try request.lease?.requireValid()
        guard let data = request.image.pngData() else { throw CocoaError(.fileWriteUnknown) }

        var saved: Result<String, Error>?
        var coordinationError: NSError?
        NSFileCoordinator().coordinate(writingItemAt: folder, options: .forMerging, error: &coordinationError) { destination in
            saved = Result {
                // A same-named file, even one created concurrently, stays the user's original.
                for name in ["Mermaid 图表.png", "Mermaid 图表-\(UUID().uuidString).png"] {
                    try Task.checkCancellation()
                    try request.lease?.requireValid()
                    do {
                        try data.write(to: destination.appendingPathComponent(name), options: [.withoutOverwriting, .completeFileProtection])
                        return name
                    } catch let error as CocoaError where error.code == .fileWriteFileExists { continue }
                }
                throw CocoaError(.fileWriteFileExists)
            }
        }
        if let coordinationError { throw coordinationError }
        guard let saved else { throw CocoaError(.fileWriteUnknown) }
        return try saved.get()
    }
}

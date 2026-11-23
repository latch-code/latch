import LatchNativeCore
import MermaidLayout
import MermaidRender
import UIKit

/** Serial layout keeps several opened diagrams from allocating several raster surfaces at once. */
actor NativeMermaidRenderer {
    private static let worker = NativeMermaidRenderer()

    static func render(_ source: String, dark: Bool) async throws -> MermaidDiagramImage {
        try await worker.draw(source, dark: dark)
    }

    private func draw(_ original: String, dark: Bool) throws -> MermaidDiagramImage {
        try Task.checkCancellation()
        guard let source = PhoneDiagramSource.prepare(original), let diagram = MermaidParser.parse(source) else { throw NativeFailure.unsupported }
        if case .flowchart(let chart) = diagram {
            // MermaidKit reports statements it dropped. A partial flowchart can describe the wrong process.
            guard chart.nodes.count <= 160, chart.edges.count <= 320, chart.subgraphs.count <= 32,
                  MermaidParser.diagnose(source).isEmpty else { throw NativeFailure.unsupported }
        }
        try Task.checkCancellation()

        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        func resolved(_ color: UIColor) -> UIColor { color.resolvedColor(with: traits) }
        let theme = DiagramTheme(
            ink: resolved(UIColor(PhoneTheme.ink)), secondaryTextColor: resolved(UIColor(PhoneTheme.ink2)),
            tertiaryTextColor: resolved(UIColor(PhoneTheme.muted)), canvas: resolved(UIColor(PhoneTheme.canvas)),
            accent: resolved(UIColor(PhoneTheme.ink2)), hairline: resolved(UIColor(PhoneTheme.lineStrong)), prefersDark: dark
        )
        // The in-memory vector API is uncached. It gives us the real bounds before any bitmap allocation,
        // independently of screen scale. No decrypted conversation material enters a file or a process-wide image cache.
        guard let data = MermaidRenderer.pdfData(source: source, theme: theme), data.count <= 8_388_608,
              let provider = CGDataProvider(data: data as CFData), let pdf = CGPDFDocument(provider), pdf.numberOfPages == 1,
              let page = pdf.page(at: 1) else { throw NativeFailure.unsupported }
        try Task.checkCancellation()
        let bounds = page.getBoxRect(.mediaBox)
        let size = bounds.size
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              size.width <= 4096, size.height <= 4096 else { throw NativeFailure.unsupported }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.preferredRange = .standard
        format.scale = min(4, 4096 / max(size.width, size.height), sqrt(4_000_000 / (size.width * size.height)))
        let image = UIGraphicsImageRenderer(size: size, format: format).image { output in
            let context = output.cgContext
            // A fractional media box can leave the last physical row or column outside the PDF.
            context.setFillColor(theme.canvas.cgColor)
            context.fill(CGRect(x: 0, y: 0, width: ceil(size.width * format.scale) / format.scale,
                                height: ceil(size.height * format.scale) / format.scale))
            context.translateBy(x: -bounds.minX, y: size.height + bounds.minY)
            context.scaleBy(x: 1, y: -1)
            context.drawPDFPage(page)
        }
        try Task.checkCancellation()
        let label = MermaidRenderer.altText(diagram: diagram)
            .replacingOccurrences(of: #"(?i)<br\s*/?>"#, with: " ", options: .regularExpression)
        return MermaidDiagramImage(image: image, size: size, accessibilityLabel: label)
    }
}

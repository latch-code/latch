import LatchNativeCore
import UIKit

/** The editor displays a short label and retains the full marker for editing, copying and sending. */
struct PromptMentionChip: Hashable {
    enum Icon: Hashable { case member(String?), file }
    let marker: String
    let name: String
    let icon: Icon

    @MainActor private static func fileIcon(_ name: String, ink: UIColor, traits: UITraitCollection) -> UIImage? {
        let symbol: String
        switch (name as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif", "bmp", "tif", "tiff", "ico": symbol = "photo"
        case "mp4", "mov", "m4v", "webm", "mkv", "avi": symbol = "film"
        case "mp3", "m4a", "wav", "aac", "flac", "ogg", "opus": symbol = "waveform"
        case "xls", "xlsx", "csv", "tsv", "numbers": symbol = "tablecells"
        case "ppt", "pptx", "key": symbol = "rectangle.on.rectangle"
        case "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar": symbol = "doc.zipper"
        case "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "yml", "yaml", "toml", "py", "rb", "go", "rs",
             "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp", "cs", "php", "sh", "zsh", "bash", "css",
             "scss", "htm", "html", "xml", "sql", "ipynb":
            // A folded page with two chevrons, matching the desktop's code-file glyph.
            return UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16), format: UIGraphicsImageRendererFormat(for: traits)).image { _ in
                let path = UIBezierPath()
                func stroke(_ points: [CGPoint]) {
                    guard let first = points.first else { return }
                    path.move(to: first)
                    for point in points.dropFirst() { path.addLine(to: point) }
                }
                stroke([CGPoint(x: 3, y: 1), CGPoint(x: 9, y: 1), CGPoint(x: 13, y: 5), CGPoint(x: 13, y: 15), CGPoint(x: 3, y: 15)])
                path.close()
                stroke([CGPoint(x: 9, y: 1), CGPoint(x: 9, y: 5), CGPoint(x: 13, y: 5)])
                stroke([CGPoint(x: 6.7, y: 8), CGPoint(x: 5, y: 9.7), CGPoint(x: 6.7, y: 11.4)])
                stroke([CGPoint(x: 9.2, y: 8), CGPoint(x: 10.9, y: 9.7), CGPoint(x: 9.2, y: 11.4)])
                ink.setStroke(); path.lineJoinStyle = .round; path.lineCapStyle = .round; path.lineWidth = 1.3; path.stroke()
            }
        default: symbol = "doc.text"
        }
        return UIImage(systemName: symbol)?.withTintColor(ink, renderingMode: .alwaysOriginal)
    }

    @MainActor func attachment(font: UIFont, traits: UITraitCollection, maxWidth: CGFloat) -> NSTextAttachment {
        let dark = traits.userInterfaceStyle == .dark
        let iconSide = round(font.pointSize * 0.875)
        let labelFont = UIFont.systemFont(ofSize: font.pointSize * 0.94)
        let ink: UIColor, wash: UIColor, glyph: UIImage?
        switch icon {
        case let .member(mark):
            ink = UIColor.label.resolvedColor(with: traits)
            wash = PhoneTheme.uiDynamic(0x12121C, 0xFFFFFF, alpha: (0.05, 0.07)).resolvedColor(with: traits)
            let original = EngineTile.icon(mark, dark: dark)
            glyph = original?.renderingMode == .alwaysTemplate ? original?.withTintColor(ink, renderingMode: .alwaysOriginal) : original
        case .file:
            ink = PhoneTheme.uiDynamic(0x1D52C4, 0x80AAFB).resolvedColor(with: traits)
            wash = PhoneTheme.uiDynamic(0x2461E0, 0x6B9BFA, alpha: (0.05, 0.09)).resolvedColor(with: traits)
            glyph = Self.fileIcon(name, ink: ink, traits: traits)
        }

        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        let label = NSAttributedString(string: PhoneConversation.visible(name, preservingLayout: false),
            attributes: [.font: labelFont, .foregroundColor: ink, .paragraphStyle: paragraph])
        let margin: CGFloat = 2, leading: CGFloat = 4, gap: CGFloat = 4, trailing: CGFloat = 6
        let fixed = 2 * margin + leading + iconSide + gap + trailing
        let textWidth = min(ceil(label.size().width), labelFont.pointSize * 16, max(1, maxWidth - fixed))
        let height = ceil(labelFont.lineHeight)
        let size = CGSize(width: fixed + textWidth, height: height)
        let format = UIGraphicsImageRendererFormat(for: traits)
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            let surface = CGRect(origin: .zero, size: size).insetBy(dx: margin, dy: 0)
            wash.setFill()
            UIBezierPath(roundedRect: surface, cornerRadius: 6).fill()
            if let glyph, glyph.size.width > 0, glyph.size.height > 0 {
                let scale = iconSide / max(glyph.size.width, glyph.size.height)
                let width = glyph.size.width * scale, glyphHeight = glyph.size.height * scale
                glyph.draw(in: CGRect(x: surface.minX + leading + (iconSide - width) / 2,
                    y: (height - glyphHeight) / 2, width: width, height: glyphHeight))
            }
            label.draw(with: CGRect(x: surface.minX + leading + iconSide + gap, y: (height - labelFont.lineHeight) / 2,
                width: textWidth, height: height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        }
        let result = NSTextAttachment(image: image)
        result.bounds = CGRect(x: 0, y: (font.capHeight - height) / 2, width: size.width, height: size.height)
        result.accessibilityLabel = marker
        return result
    }
}

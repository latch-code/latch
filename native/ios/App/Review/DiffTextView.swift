import LatchNativeCore
import SwiftUI
import UIKit

/**
 * A run of diff lines in a read-only TextKit 2 view: monospaced, a line-number gutter, the added and removed lines on
 * pale green and red, picked lines in pale blue and lines a note covers marked in the gutter. A tap on a line picks it.
 * The text is not selectable, so nothing is copied or dragged out of it.
 */
struct DiffTextView: UIViewRepresentable {
    let lines: [PhoneReviewLine]
    let selection: PhoneLineSelection?
    let noted: Set<Int>
    let onTap: ((PhoneReviewLine) -> Void)?
    @Environment(\.colorScheme) private var scheme

    func makeUIView(context: Context) -> DiffLinesView {
        let view = DiffLinesView(usingTextLayoutManager: true)
        view.isEditable = false; view.isSelectable = false; view.isScrollEnabled = false
        view.backgroundColor = .clear; view.textContainerInset = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 8)
        view.textContainer.lineFragmentPadding = 0
        view.textDragInteraction?.isEnabled = false
        if #available(iOS 18, *) { view.writingToolsBehavior = .none }
        view.adjustsFontForContentSizeCategory = false
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        view.addGestureRecognizer(tap)
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: DiffLinesView, context: Context) {
        context.coordinator.parent = self
        let tones = lines.enumerated().map { index, line -> DiffLinesView.Tone in
            if selection?.contains(line) == true { return .picked }
            switch line.kind { case .add: return .add; case .remove: return .remove; case .context: return .plain }
        }
        let key = DiffLinesView.Key(lines: lines, tones: tones, noted: noted, dark: scheme == .dark)
        guard view.key != key else { return }
        view.key = key
        view.attributedText = Self.text(lines, noted: noted)
        view.tones = tones
        view.accessibilityLabel = lines.map { line in
            let number = line.number(on: line.side).map { "第 \($0) 行" } ?? ""
            return number + (line.kind == .add ? " 新增 " : line.kind == .remove ? " 删除 " : " ") + PhoneConversation.visible(line.text)
        }.joined(separator: "\n")
        view.setNeedsLayout()
        view.invalidateIntrinsicContentSize()
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: DiffLinesView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        return CGSize(width: width, height: uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    static func text(_ lines: [PhoneReviewLine], noted: Set<Int>) -> NSAttributedString {
        let font = UIFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
        let gutter = max(3, String(lines.compactMap { max($0.oldLine ?? 0, $0.newLine ?? 0) }.max() ?? 0).count)
        let out = NSMutableAttributedString()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byCharWrapping
        // A wrapped line continues under its text, not under the number.
        paragraph.headIndent = CGFloat(gutter + 3) * font.pointSize * 0.6
        for (index, line) in lines.enumerated() {
            let number = line.number(on: line.side).map(String.init) ?? ""
            let pad = String(repeating: " ", count: max(0, gutter - number.count))
            let mark = noted.contains(index) ? "▍" : line.kind == .add ? "+" : line.kind == .remove ? "−" : " "
            let gutterColor: UIColor = noted.contains(index) ? UIColor(PhoneTheme.amberIcon) : UIColor(PhoneTheme.faint)
            out.append(NSAttributedString(string: pad + number + " ", attributes: [.font: font, .foregroundColor: UIColor(PhoneTheme.faint), .paragraphStyle: paragraph]))
            out.append(NSAttributedString(string: mark + " ", attributes: [.font: font, .foregroundColor: gutterColor, .paragraphStyle: paragraph]))
            // Hidden and bidirectional characters are drawn as \u{XXXX}, as everywhere in the App, never acted on.
            let shown = PhoneConversation.visible(line.text)
            out.append(NSAttributedString(string: shown + (index < lines.count - 1 ? "\n" : ""),
                attributes: [.font: font, .foregroundColor: UIColor(PhoneTheme.ink), .paragraphStyle: paragraph]))
        }
        return out
    }

    @MainActor final class Coordinator: NSObject {
        var parent: DiffTextView
        init(parent: DiffTextView) { self.parent = parent }
        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard let view = gesture.view as? DiffLinesView, let index = view.line(at: gesture.location(in: view)), parent.lines.indices.contains(index) else { return }
            parent.onTap?(parent.lines[index])
        }
    }
}

/** The text view under a diff run: each line's fragment paints its full width behind the text, as TextKit 2 lays it out. */
final class DiffLinesView: UITextView, @preconcurrency NSTextLayoutManagerDelegate {
    enum Tone: Equatable { case plain, add, remove, picked }
    struct Key: Equatable { let lines: [PhoneReviewLine]; let tones: [Tone]; let noted: Set<Int>; let dark: Bool }
    var key: Key?
    var tones: [Tone] = [] { didSet { relayout() } }
    /** Where each line starts, in UTF-16 units of the text. */
    private var starts: [Int] = []
    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        textLayoutManager?.delegate = self
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: DiffLinesView, _) in view.relayout() }
    }
    required init?(coder: NSCoder) { nil }
    override var attributedText: NSAttributedString! {
        didSet {
            var offset = 0
            starts = (attributedText?.string ?? "").components(separatedBy: "\n").map { line in defer { offset += line.utf16.count + 1 }; return offset }
        }
    }
    private func relayout() {
        guard let manager = textLayoutManager else { return }
        // The text view makes its layout manager after init: take it over here, before the fragments are made again.
        if manager.delegate !== self { manager.delegate = self }
        manager.invalidateLayout(for: manager.documentRange)
        setNeedsLayout()
    }
    private var laidWidth: CGFloat = 0
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != laidWidth { laidWidth = bounds.width; relayout() }
    }
    func color(_ index: Int) -> UIColor? {
        guard tones.indices.contains(index) else { return nil }
        let dark = traitCollection.userInterfaceStyle == .dark
        switch tones[index] {
        case .plain: return nil
        case .add: return UIColor(PhoneTheme.green).withAlphaComponent(dark ? 0.16 : 0.10)
        case .remove: return UIColor(PhoneTheme.red).withAlphaComponent(dark ? 0.16 : 0.09)
        case .picked: return UIColor(PhoneTheme.accent).withAlphaComponent(0.18)
        }
    }
    func index(of location: NSTextLocation) -> Int? {
        guard let manager = textLayoutManager else { return nil }
        let offset = manager.offset(from: manager.documentRange.location, to: location)
        return starts.lastIndex { $0 <= offset }
    }
    func textLayoutManager(_ manager: NSTextLayoutManager, textLayoutFragmentFor location: any NSTextLocation, in element: NSTextElement) -> NSTextLayoutFragment {
        let fragment = LineFragment(textElement: element, range: element.elementRange)
        fragment.fill = index(of: location).flatMap(color)
        fragment.width = bounds.width
        return fragment
    }
    func line(at point: CGPoint) -> Int? {
        guard let manager = textLayoutManager,
              let fragment = manager.textLayoutFragment(for: CGPoint(x: 1, y: point.y - textContainerInset.top)) else { return nil }
        return index(of: fragment.rangeInElement.location)
    }
}

/** One line, its background across the whole width. */
final class LineFragment: NSTextLayoutFragment {
    var fill: UIColor?
    var width: CGFloat = 0
    override var renderingSurfaceBounds: CGRect {
        let base = super.renderingSurfaceBounds
        return base.union(CGRect(x: -layoutFragmentFrame.minX, y: 0, width: max(width, layoutFragmentFrame.width), height: layoutFragmentFrame.height))
    }
    override func draw(at point: CGPoint, in context: CGContext) {
        if let fill {
            context.saveGState()
            context.setFillColor(fill.cgColor)
            context.fill(CGRect(x: point.x - layoutFragmentFrame.minX, y: point.y, width: max(width, layoutFragmentFrame.width), height: layoutFragmentFrame.height))
            context.restoreGState()
        }
        super.draw(at: point, in: context)
    }
}

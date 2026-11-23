import SwiftUI
import UIKit
import UniformTypeIdentifiers

/** The renderer returns a bounded image of the entire diagram and its natural layout size in points. */
struct MermaidDiagramImage {
    let image: UIImage
    let size: CGSize
    let accessibilityLabel: String
}

struct MermaidDiagramView: View {
    let source: String

    var body: some View {
        MermaidPreview(source: source).id(source)
    }
}

private struct MermaidPreview: View {
    let source: String
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.scenePhase) private var phase
    @Environment(\.colorScheme) private var scheme
    @State private var showing = true
    @State private var inView = false
    @State private var expanded = false
    @State private var drawing: MermaidDiagramImage?
    @State private var drawnDark: Bool?
    @State private var failed = false
    @State private var feedback: String?
    @State private var saveRequest: MermaidImageSave?
    @State private var choosingFolder = false
    @State private var selectedFolder: URL?

    private var available: Bool { phase == .active && model.hasContentWindow }
    private var requestedTheme: Bool? { showing && available && (inView || expanded) ? scheme == .dark : nil }
    private var current: MermaidDiagramImage? { showing && drawnDark == (scheme == .dark) ? drawing : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if available {
                if let current {
                    HStack(spacing: 0) {
                        if let feedback { Text(feedback).font(.caption).foregroundStyle(PhoneTheme.muted) }
                        Spacer()
                        Menu {
                            Button("复制为代码", systemImage: "chevron.left.forwardslash.chevron.right") {
                                guard available else { return }
                                LocalClipboard.copy(source)
                                report("已复制代码")
                            }.accessibilityIdentifier("mermaid-copy-source")
                            Button("复制图像", systemImage: "photo.on.rectangle") { copyImage(current) }
                                .accessibilityIdentifier("mermaid-copy-image")
                            Button("存储图像…", systemImage: "square.and.arrow.down") {
                                guard available, saveRequest == nil else { return }
                                saveRequest = MermaidImageSave(image: current.image, model: model)
                                choosingFolder = true
                            }.disabled(saveRequest != nil).accessibilityIdentifier("mermaid-save-image")
                            Button("查看源码", systemImage: "text.alignleft") { showing = false; feedback = nil }
                                .accessibilityIdentifier("mermaid-source")
                        } label: { DiagramGlyph(name: "ellipsis") }
                        .accessibilityLabel("图表操作").accessibilityIdentifier("mermaid-actions")
                        Button { expanded = true } label: { DiagramGlyph(name: "arrow.up.left.and.arrow.down.right") }
                            .accessibilityLabel("展开图表").accessibilityIdentifier("mermaid-expand")
                    }
                    MermaidCanvas(diagram: current, expanded: false)
                } else if showing {
                    ProgressView("正在绘制图表…").font(.caption).padding(.vertical, 8)
                } else {
                    Button {
                        failed = false
                        showing = true
                    } label: {
                        Label(failed ? "重新绘制" : "显示图表", systemImage: "point.3.connected.trianglepath.dotted")
                            .font(.subheadline.weight(.medium)).frame(minHeight: 44)
                    }.accessibilityIdentifier("mermaid-show")
                    if failed {
                        Text("暂时无法绘制这张图，可查看下方源码。").font(.caption).foregroundStyle(PhoneTheme.muted)
                    }
                    MarkdownCode(code: source, language: "mermaid")
                }
            }
        }
        .foregroundStyle(PhoneTheme.ink)
        .buttonStyle(.plain)
        .privacySensitive()
        .background {
            if let request = saveRequest {
                Color.clear.fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
                    guard saveRequest?.id == request.id else { return }
                    guard available, request.matches(model) else { clearSave(); return }
                    if case .success(let urls) = result, let folder = urls.first {
                        selectedFolder = folder
                    } else {
                        clearSave()
                        report("暂时无法打开所选文件夹")
                    }
                } onCancellation: {
                    if saveRequest?.id == request.id { clearSave() }
                }
            }
        }
        .task(id: selectedFolder) {
            guard let folder = selectedFolder, let request = saveRequest else { return }
            defer { if saveRequest?.id == request.id { clearSave() } }
            guard available, request.matches(model) else { return }
            do {
                let name = try await MermaidImageWriter.shared.save(request, in: folder)
                if !Task.isCancelled, available, request.matches(model) { report("已存储为 " + name) }
            } catch {
                if !Task.isCancelled, available, request.matches(model) { report("图像未能存储，请重选文件夹。") }
            }
        }
        .onGeometryChange(for: Bool.self) { geometry in
            guard !geometry.size.equalTo(.zero) else { return false }
            guard let viewport = geometry.bounds(of: .scrollView) else { return true }
            return CGRect(origin: .zero, size: geometry.size).intersects(viewport)
        } action: { inView = $0 }
        .task(id: requestedTheme) {
            guard let dark = requestedTheme else { return }
            if drawing != nil, drawnDark == dark { return }
            do {
                let next = try await NativeMermaidRenderer.render(source, dark: dark)
                guard !Task.isCancelled, available else { return }
                drawing = next
                drawnDark = dark
            } catch {
                guard !Task.isCancelled, available else { return }
                showing = false
                failed = true
                expanded = false
            }
        }
        .onChange(of: available) { _, open in
            if !open {
                expanded = false; showing = true; drawing = nil; drawnDark = nil; feedback = nil; failed = false
                clearSave()
            }
        }
        .task(id: feedback) {
            guard feedback != nil else { return }
            try? await Task.sleep(for: .seconds(2.5))
            if !Task.isCancelled { feedback = nil }
        }
        .fullScreenCover(isPresented: $expanded) {
            NavigationStack {
                Group {
                    if available, let current {
                        MermaidCanvas(diagram: current, expanded: true).privacySensitive()
                    } else if available && showing {
                        ProgressView("正在绘制图表…")
                    } else {
                        PhoneTheme.canvas
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(PhoneTheme.canvas)
                .navigationTitle("Mermaid 图表")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("关闭") { expanded = false }.keyboardShortcut(.cancelAction).accessibilityIdentifier("mermaid-close")
                    }
                }
            }
        }
    }

    private func copyImage(_ diagram: MermaidDiagramImage) {
        guard available else { return }
        guard let data = diagram.image.pngData() else { report("图像复制失败"); return }
        guard available else { return }
        LocalClipboard.copy(png: data)
        report("已复制图像")
    }

    private func report(_ text: String) {
        feedback = text
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    private func clearSave() {
        choosingFolder = false
        selectedFolder = nil
        saveRequest = nil
    }
}

private struct DiagramGlyph: View {
    let name: String
    var body: some View {
        Image(systemName: name).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink2)
            .frame(width: 44, height: 44).contentShape(Rectangle())
    }
}

private struct MermaidCanvas: View {
    let diagram: MermaidDiagramImage
    let expanded: Bool
    @StateObject private var zoom = DiagramZoom()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var identifier: String { expanded ? "mermaid-expanded" : "mermaid-inline" }

    var body: some View {
        VStack(spacing: 4) {
            DiagramScroll(diagram: diagram, expanded: expanded, zoom: zoom)
            HStack(spacing: 0) {
                Button { zoom.surface?.step(up: false, animated: !reduceMotion) } label: { DiagramGlyph(name: "minus") }
                    .disabled(!zoom.canShrink).accessibilityLabel("缩小").accessibilityIdentifier(identifier + "-shrink")
                Text(zoom.label).font(.caption.monospacedDigit()).foregroundStyle(PhoneTheme.muted)
                    .accessibilityLabel("缩放比例").accessibilityValue(zoom.label).accessibilityIdentifier(identifier + "-scale")
                Button { zoom.surface?.step(up: true, animated: !reduceMotion) } label: { DiagramGlyph(name: "plus") }
                    .disabled(!zoom.canGrow).accessibilityLabel("放大").accessibilityIdentifier(identifier + "-grow")
                Button { zoom.surface?.fit(animated: !reduceMotion) } label: {
                    Text("适应全图").font(.subheadline).padding(.horizontal, 8).frame(minHeight: 44)
                }.accessibilityIdentifier(identifier + "-fit")
            }
            .buttonStyle(.plain).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: expanded ? .center : .trailing)
        }
    }
}

@MainActor private final class DiagramZoom: ObservableObject {
    weak var surface: DiagramScrollView?
    @Published private var scale: CGFloat = 1
    @Published private var minimum: CGFloat = 0.1
    var canShrink: Bool { scale > minimum + 0.0001 }
    var canGrow: Bool { scale < DiagramScrollView.limit - 0.0001 }
    var label: String { Double(scale).formatted(.percent.precision(.fractionLength(scale < 0.1 ? 1 : 0))) }

    func read(_ view: DiagramScrollView) {
        guard surface === view else { return }
        if scale != view.zoomScale { scale = view.zoomScale }
        if minimum != view.minimumZoomScale { minimum = view.minimumZoomScale }
    }
}

private struct DiagramScroll: UIViewRepresentable {
    let diagram: MermaidDiagramImage
    let expanded: Bool
    let zoom: DiagramZoom

    func makeUIView(context: Context) -> DiagramScrollView {
        let view = DiagramScrollView()
        view.state = zoom
        zoom.surface = view
        return view
    }

    func updateUIView(_ view: DiagramScrollView, context: Context) {
        view.display(diagram)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: DiagramScrollView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        if expanded {
            guard let height = proposal.height, height.isFinite else { return nil }
            return CGSize(width: width, height: height)
        }
        let height = diagram.size.height * min(1, width / diagram.size.width)
        return CGSize(width: width, height: min(360, max(60, ceil(height))))
    }
}

@MainActor private final class DiagramScrollView: UIScrollView, UIScrollViewDelegate {
    static let limit: CGFloat = 4
    private let picture = UIImageView()
    weak var state: DiagramZoom?
    private var natural = CGSize.zero
    private var room = CGSize.zero
    private var fitted: CGFloat = 1
    private var readScheduled = false
    private static let steps: [CGFloat] = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

    init() {
        super.init(frame: .zero)
        delegate = self
        contentInsetAdjustmentBehavior = .never
        bouncesZoom = false
        maximumZoomScale = Self.limit
        picture.isAccessibilityElement = true
        picture.accessibilityTraits = .image
        addSubview(picture)
    }

    required init?(coder: NSCoder) { nil }

    func display(_ diagram: MermaidDiagramImage) {
        guard picture.image !== diagram.image else { return }
        picture.image = diagram.image
        picture.accessibilityLabel = diagram.accessibilityLabel
        let next = diagram.size
        guard natural != next else { return }
        natural = next
        room = .zero
        setZoomScale(1, animated: false)
        picture.frame = CGRect(origin: .zero, size: natural)
        contentSize = natural
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard natural.width > 0, natural.height > 0, bounds.width > 0, bounds.height > 0 else { return }
        if room != bounds.size {
            let followFit = room == .zero || abs(zoomScale - fitted) < 0.0001
            room = bounds.size
            fitted = min(1, room.width / natural.width, room.height / natural.height)
            minimumZoomScale = min(0.1, fitted)
            if followFit { fit(animated: false) }
        }
        centerPicture()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerPicture() }

    private func centerPicture() {
        picture.center = CGPoint(x: max(bounds.width, picture.frame.width) / 2, y: max(bounds.height, picture.frame.height) / 2)
        // A fitted inline diagram lets the surrounding conversation take the person's vertical swipe.
        let canPan = picture.frame.width > bounds.width + 1 || picture.frame.height > bounds.height + 1
        if panGestureRecognizer.isEnabled != canPan { panGestureRecognizer.isEnabled = canPan }
        guard !readScheduled else { return }
        readScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            readScheduled = false
            state?.read(self)
        }
    }

    func fit(animated: Bool) { setZoomScale(fitted, animated: animated) }

    func step(up: Bool, animated: Bool) {
        let next = up
            ? Self.steps.first { $0 > zoomScale + 0.0001 } ?? Self.limit
            : Self.steps.last { $0 < zoomScale - 0.0001 } ?? minimumZoomScale
        let center = convert(CGPoint(x: bounds.midX, y: bounds.midY), to: picture)
        let size = CGSize(width: bounds.width / next, height: bounds.height / next)
        zoom(to: CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height), animated: animated)
    }
}

import LatchNativeCore
import SwiftUI
import UIKit

struct PhoneRootView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var scan = false
    private var hasComputers: Bool {
        #if LATCH_SCREENS
        if model.staged { return true }
        #endif
        return !(model.hosts.isEmpty && model.selectedHost == nil)
    }
    var body: some View {
        Group {
            switch model.storeState {
            case .opening: PhoneTheme.canvas.ignoresSafeArea()
            case let .unavailable(failure):
                ContentUnavailableView {
                    Label("无法打开安全存储", systemImage: "lock.circle")
                } description: {
                    VStack(spacing: 8) {
                        #if targetEnvironment(simulator)
                        Text("请在 iPhone 或 iPad 真机上打开 Latch。连接电脑需要设备的安全存储。")
                        #else
                        Text(failure.advice)
                        #endif
                        Text(failure.code).font(.caption.monospaced()).foregroundStyle(PhoneTheme.muted)
                    }
                } actions: {
                    Button("重试") { Task { await model.open() } }
                }
            case .ready:
                if hasComputers { RootTabs(addComputer: { scan = true }) }
                else { PairingWelcome { scan = true }.padding(32).frame(maxWidth: 460) }
            }
        }
        #if LATCH_SCREENS
        .overlay {
            if ScreensStage.scene == "brands" { BrandsSheet() }
            else if ScreensStage.scene == "licenses" { NavigationStack { LicensesView() } }
        }
        #endif
        .fullScreenCover(isPresented: Binding(get: { scan || model.pairing != nil }, set: { if !$0 { scan = false } })) {
            // A cover is its own presentation; it is handed the model rather than trusting inheritance.
            PairingView { scan = false }.environmentObject(model)
        }
        .onOpenURL { url in if PairingInvitation.recognizes(url.absoluteString) { Task { await model.beginPairing(payload: url.absoluteString) } } }
        .alert("这台 Mac 已移除这台 iPhone", isPresented: $model.removedByMac) {
            Button("好") {}
        } message: { Text("需要时在 Mac 上重新扫码。") }
        .alert("暂时无法完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .onReceive(NotificationCenter.default.publisher(for: .latchStatusHint)) { _ in Task { await model.refresh() } }
        .onReceive(NotificationCenter.default.publisher(for: .latchOpenOther)) { note in
            guard let computer = note.userInfo?["computer"] as? String, let session = note.userInfo?["session"] as? String else { return }
            Task { await model.requestOther(computer: computer, session: session) }
        }
        #if LATCH_SCREENS
        .onChange(of: model.staged) { _, _ in if ScreensStage.scanning { scan = true } }
        #endif
    }
}

/** A stop or a rejection whose result never came back; it keeps its request identity until the Host answers. */
struct ControlPendingBar: View {
    @EnvironmentObject private var model: PhoneModel
    var body: some View {
        // The record of a control is saved before it is sent, so while it is out there is nothing yet to confirm.
        if model.controlPending != .null && model.controlsInFlight.isEmpty {
            HStack(spacing: 12) {
                Label("上次操作结果待确认", systemImage: "clock").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber)
                Spacer()
                Button("重试这次操作") { Task { await model.retryControl() } }.font(PhoneTheme.caption).disabled(model.busy || !model.connected)
            }.padding(.horizontal, 16).padding(.vertical, 10).background(.bar)
        }
    }
}

/** Code, 我的 Agent, 应用 and 设置, as the web's phone bar has them; a place the Host stops offering falls back to Code. */
private struct RootTabs: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.colorScheme) private var scheme
    let addComputer: () -> Void
    var body: some View {
        let entries = PhoneTabs.entries(model.snapshot)
        let shown = entries.contains { $0.id == model.tab } ? model.tab : .code
        let dot = PhoneTabs.codeDot(model.snapshot, current: shown), agentsDot = PhoneTabs.agentsDot(model.snapshot, current: shown)
        TabView(selection: Binding(get: { shown }, set: { next in
            // Code shows Code's sessions: a topic of 我的 Agent left open there is closed on the way back, as the web's switch does.
            if next != .code && model.workItemsShown { model.setWorkPath([]) }
            if next == .code, PhoneSpaces.belongsElsewhere(model.snapshot, sessionId: model.sessionId, from: .code) { model.closeSession() }
            model.tab = next
        })) {
            ForEach(entries) { entry in
                page(entry.id)
                    .tabItem {
                        // Not a count and not the system's red badge: amber says something waits on you in Code.
                        if entry.id == .code && dot { Label { Text(entry.label) } icon: { Self.dotted(entry.symbol, scheme: scheme) }.accessibilityValue("有等你处理") }
                        else if entry.id == .agents && agentsDot { Label { Text(entry.label) } icon: { Self.dotted(Self.agentsImage, scheme: scheme) }.accessibilityValue("有等你处理") }
                        else if entry.id == .agents { Label { Text(entry.label) } icon: { Self.agentsMark } }
                        else { Label { Text(entry.label) } icon: { Self.symbol(entry.symbol) } }
                    }
                    // One family of line icons: the bar does not fill the selected one.
                    .environment(\.symbolVariants, .none)
                    .tag(entry.id)
            }
        }
        .tint(PhoneTheme.ink)
    }
    @ViewBuilder private func page(_ tab: PhoneTab) -> some View {
        switch tab {
        case .code: InboxView()
        case .agents: AgentsTabView()
        case .apps: AppsTabView()
        case .settings: PhoneSettingsView(addComputer: addComputer)
        }
    }
    /** The bar's icons are drawn at one size and weight, so the drawn face and the SF Symbols beside it match. */
    private static let barSymbol = UIImage.SymbolConfiguration(pointSize: 18, weight: .regular)
    private static func symbol(_ name: String) -> Image {
        Image(uiImage: (UIImage(systemName: name, withConfiguration: barSymbol) ?? UIImage()).withRenderingMode(.alwaysTemplate))
    }
    /**
     * 我的 Agent's tab glyph, in this one place: the avatar's curly-brace face with dot eyes, `{··}`, as a monochrome
     * template the bar tints. Its paths are the avatar's (`FaceGeometry`), cropped to the face itself so its height is the symbols' cap height and stroked at
     * the SF Symbols' regular weight beside it.
     */
    private enum AgentsGlyph {
        static let brackets = FaceGeometry.brackets["curly"] ?? []
        /** The avatar's dot eyes, set a little low as there, sized to the thinner line. */
        static let eyes = FaceGeometry.eyeX.map { FaceGeometry.dot($0, 21.2, 1.6) }
        /** The face's own box on the 40 grid, its stroke included: as tall as the gear's cap height. */
        static let box = CGRect(x: 7.9, y: 11.1, width: 24.2, height: 18.8)
        /** In points: the line SF Symbols draw at regular weight at the bar's 18 pt, so the face has the symbols' weight. */
        static let strokePoints: CGFloat = 1.6
    }
    private static let agentsMark = Image(uiImage: agentsImage.withRenderingMode(.alwaysTemplate))
    private static let agentsImage: UIImage = {
        let reference = UIImage(systemName: "gearshape", withConfiguration: barSymbol) ?? UIImage()
        let unit = max(reference.size.height, 20) / AgentsGlyph.box.height
        let grid = CGRect(x: 0, y: 0, width: 40 * unit, height: 40 * unit)
        let image = UIGraphicsImageRenderer(size: CGSize(width: AgentsGlyph.box.width * unit, height: AgentsGlyph.box.height * unit)).image { context in
            let cg = context.cgContext
            // The 40 grid at this size, moved so the face's box is the image.
            cg.translateBy(x: -AgentsGlyph.box.minX * unit, y: -AgentsGlyph.box.minY * unit)
            cg.setStrokeColor(UIColor.black.cgColor); cg.setFillColor(UIColor.black.cgColor)
            cg.setLineWidth(AgentsGlyph.strokePoints); cg.setLineCap(.round); cg.setLineJoin(.round)
            for d in AgentsGlyph.brackets { cg.addPath(GridPath(d: d).path(in: grid).cgPath); cg.strokePath() }
            for d in AgentsGlyph.eyes { cg.addPath(GridPath(d: d).path(in: grid).cgPath); cg.fillPath() }
        }
        return image
    }()

    /** The tab's symbol in the bar's unselected ink with an amber dot at its corner; drawn, since a tab item takes one image. */
    private static func dotted(_ symbol: String, scheme: ColorScheme) -> Image {
        dotted(UIImage(systemName: symbol, withConfiguration: barSymbol) ?? UIImage(), scheme: scheme)
    }
    private static func dotted(_ base: UIImage, scheme: ColorScheme) -> Image {
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        let ink = UIColor.label.resolvedColor(with: traits), amber = UIColor(PhoneTheme.amberIcon).resolvedColor(with: traits)
        let dot: CGFloat = 7, size = CGSize(width: base.size.width + dot / 2, height: base.size.height + dot / 2)
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            base.withTintColor(ink, renderingMode: .alwaysOriginal).draw(at: CGPoint(x: 0, y: dot / 2))
            amber.setFill()
            UIBezierPath(ovalIn: CGRect(x: size.width - dot, y: 0, width: dot, height: dot)).fill()
        }
        return Image(uiImage: image.withRenderingMode(.alwaysOriginal))
    }
}

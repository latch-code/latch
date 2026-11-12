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
            if !model.storeReady { PhoneTheme.canvas.ignoresSafeArea() }
            else if !hasComputers {
                PairingWelcome { scan = true }.padding(32).frame(maxWidth: 460)
            } else { RootTabs(addComputer: { scan = true }) }
        }
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
        let dot = PhoneTabs.codeDot(model.snapshot, current: shown)
        TabView(selection: Binding(get: { shown }, set: { model.tab = $0 })) {
            ForEach(entries) { entry in
                page(entry.id)
                    .tabItem {
                        // Not a count and not the system's red badge: amber says something waits on you in Code.
                        if entry.id == .code && dot { Label { Text(entry.label) } icon: { Self.dotted(entry.symbol, scheme: scheme) }.accessibilityValue("有等你处理") }
                        else { Label(entry.label, systemImage: entry.symbol) }
                    }
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
    /** The tab's symbol in the bar's unselected ink with an amber dot at its corner; drawn, since a tab item takes one image. */
    private static func dotted(_ symbol: String, scheme: ColorScheme) -> Image {
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        let base = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)) ?? UIImage()
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

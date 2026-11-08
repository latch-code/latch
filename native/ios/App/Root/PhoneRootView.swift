import LatchNativeCore
import SwiftUI

enum PhoneTab: Hashable { case sessions, agents, settings }

struct PhoneRootView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var scan = false
    @State private var tab = PhoneTab.sessions
    var body: some View {
        Group {
            if !model.storeReady { PhoneTheme.canvas.ignoresSafeArea() }
            else if model.hosts.isEmpty && model.selectedHost == nil {
                PairingWelcome { scan = true }.padding(32).frame(maxWidth: 460)
            } else {
                TabView(selection: $tab) {
                    InboxView().tabItem { Label("会话", systemImage: "bubble.left.and.bubble.right") }.tag(PhoneTab.sessions)
                    AgentTabView().tabItem { Label("Agent", systemImage: "cpu") }.tag(PhoneTab.agents)
                    PhoneSettingsView { scan = true }.tabItem { Label("设置", systemImage: "gearshape") }.tag(PhoneTab.settings)
                }.tint(PhoneTheme.ink)
            }
        }
        .fullScreenCover(isPresented: Binding(get: { scan || model.pairing != nil }, set: { if !$0 { scan = false } })) {
            PairingView { scan = false }
        }
        .onOpenURL { url in if PairingInvitation.recognizes(url.absoluteString) { Task { await model.beginPairing(payload: url.absoluteString) } } }
        .alert("这台 Mac 已移除这台 iPhone", isPresented: $model.removedByMac) {
            Button("好") {}
        } message: { Text("需要时在 Mac 上重新扫码。") }
        .alert("暂时无法完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .onReceive(NotificationCenter.default.publisher(for: .latchStatusHint)) { _ in Task { await model.refresh() } }
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

/** Until the Host's agents arrive, the tab lists what is installed and what this phone may start on it. */
struct AgentTabView: View {
    @EnvironmentObject private var model: PhoneModel
    private var catalog: NativeJSON { model.snapshot["catalog"] }
    var body: some View {
        NavigationStack {
            List {
                Section("已安装") {
                    if PhoneStart.engines(catalog).isEmpty {
                        Text(model.connected ? "还没有可用的 Harness" : "连上 Mac 后显示").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                    }
                    ForEach(PhoneStart.engines(catalog)) { engine in
                        HStack(spacing: 12) {
                            EngineTile(mark: model.engineMark(engine.id), size: 28)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(engine.name).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink)
                            }
                        }.padding(.vertical, 2)
                    }
                }
            }
            .navigationTitle("Agent")
        }
    }
}

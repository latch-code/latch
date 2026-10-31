import LatchNativeCore
import SwiftUI

struct PhoneRootView: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var scan = false
    @State private var settings = false
    var body: some View {
        NavigationSplitView {
            List {
                if model.selectedHost != nil {
                    Section {
                        Button("个人助手", systemImage: "person.crop.circle") { Task { await model.openPersonalHome() } }
                            .foregroundStyle(.primary)
                        Button("项目工作", systemImage: "folder") { model.openProjects() }.foregroundStyle(.primary)
                    }
                }
                if model.hosts.isEmpty { PairingWelcome { scan = true }.listRowBackground(Color.clear) }
                ForEach(model.hosts) { host in
                    Button { Task { await model.connect(host) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "laptopcomputer").font(.system(size: 18)).foregroundStyle(.secondary).frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(host.name).foregroundStyle(.primary)
                                Text(model.selectedHost?.id == host.id ? model.status : "点按连接").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if model.selectedHost?.id == host.id { Image(systemName: "checkmark").font(.footnote.weight(.semibold)) }
                        }.padding(.vertical, 3)
                    }.disabled(model.busy || model.verifying)
                }
                Button("添加电脑", systemImage: "plus") { scan = true }.disabled(model.busy)
            }
            .navigationTitle("电脑")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("设置", systemImage: "gearshape") { settings = true }.labelStyle(.iconOnly) } }
        } detail: {
            if model.selectedHost != nil {
                if let group = model.groupId, model.sessionId == nil { PersonalGroupView(id: group) }
                else if model.area == .personal && model.assistantId == nil && model.sessionId == nil { PersonalHomeView() }
                else { SessionWorkspaceView() }
            }
            else {
                PairingWelcome { scan = true }.padding(32).frame(maxWidth: 460)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.controlPending != .null {
                HStack(spacing: 12) {
                    Label("上次操作结果待确认", systemImage: "clock").font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button("重试这次操作") { Task { await model.retryControl() } }.font(.caption).disabled(model.busy || !model.connected)
                }.padding(12).background(.bar)
            }
        }
        .fullScreenCover(isPresented: Binding(get: { scan || model.pairing != nil }, set: { if !$0 { scan = false } })) {
            PairingView { scan = false }
        }
        .sheet(isPresented: $settings) { PhoneSettingsView { settings = false; scan = true } }
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

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
                if model.hosts.isEmpty {
                    ContentUnavailableView("把电脑带在身边", systemImage: "laptopcomputer", description: Text("在电脑上的 Latch 打开手机配对，扫描二维码连接。"))
                        .listRowBackground(Color.clear)
                }
                ForEach(model.hosts) { host in
                    Button { Task { await model.connect(host) } } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "laptopcomputer").font(.system(size: 18)).foregroundStyle(.secondary).frame(width: 24)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(host.name).foregroundStyle(.primary)
                                Text(model.selectedHost?.id == host.id ? model.status : host.prepared ? "登记待核对" : "已登记").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if model.selectedHost?.id == host.id { Image(systemName: "checkmark").font(.footnote.weight(.semibold)) }
                        }.padding(.vertical, 3)
                    }.disabled(model.busy || model.verifying)
                }
                if model.draft != nil {
                    Button("继续未完成的登记", systemImage: "arrow.clockwise") { model.resumePairing() }.disabled(model.busy)
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
                VStack(spacing: 20) {
                    Image("LatchMark").resizable().frame(width: 42, height: 42).clipShape(RoundedRectangle(cornerRadius: 10))
                    Text("你的工作，随时继续").font(.title2.weight(.semibold))
                    Text("连接已登记的电脑，查看进展、回答问题并继续会话。").foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("添加电脑") { scan = true }.buttonStyle(.borderedProminent).controlSize(.large)
                }.padding(32).frame(maxWidth: 460)
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
        .sheet(isPresented: $scan) { PairingView() }
        .sheet(isPresented: $settings) { PhoneSettingsView() }
        .sheet(isPresented: Binding(get: { model.comparisonCode != nil }, set: { _ in })) {
            if let code = model.comparisonCode {
                VStack(spacing: 24) {
                    Text("在 Mac 上确认").font(.title2.weight(.semibold))
                    Text("在电脑显示的 Latch 确认窗口中输入：").foregroundStyle(.secondary)
                    Text(code).font(.system(size: 38, weight: .medium, design: .monospaced)).tracking(6).accessibilityLabel(code.map(String.init).joined(separator: " "))
                    Label("确认前不会授予手机操作权限", systemImage: "lock").font(.footnote).foregroundStyle(.secondary)
                    ProgressView().controlSize(.small)
                }.padding(32).interactiveDismissDisabled()
                    .presentationDetents([.medium])
            }
        }
        .alert("暂时无法完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .onReceive(NotificationCenter.default.publisher(for: .latchStatusHint)) { _ in Task { await model.refresh() } }
    }
}

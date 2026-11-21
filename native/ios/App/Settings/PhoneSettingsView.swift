import DeviceCheck
import LatchNativeCore
import SwiftUI
import UserNotifications
import UIKit

struct PhoneSettingsView: View {
    @EnvironmentObject private var model: PhoneModel
    let addComputer: () -> Void
    @State private var copied = false
    @AppStorage(PhoneFaceID.key) private var faceID = false
    @State private var faceIDAvailable = true
    @State private var changingFaceID = false
    @AppStorage(PhoneComputerNotices.key) private var notifyOthers = false
    @AppStorage(PhoneQuestionReminders.enabledKey) private var questionReminders = true
    @State private var changingNotices = false
    @State private var noticesRefused = false
    var body: some View {
        NavigationStack {
            Form {
                Section("电脑") {
                    ForEach(model.computerRows) { row in
                        NavigationLink {
                            PhoneHostDetail(host: row.host)
                        } label: {
                            LabeledContent(row.name, value: PhoneComputers.stateWords(row.state, lastSeen: row.lastSeen))
                        }
                    }
                    Button("添加电脑", action: addComputer)
                }
                Section {
                    Toggle("查看会话前用 Face ID", isOn: Binding(get: { faceID }, set: { next in
                        changingFaceID = true
                        Task { _ = await PhoneFaceID.change(to: next); changingFaceID = false }
                    }))
                    .disabled(changingFaceID || (!faceID && !faceIDAvailable))
                } header: { Text("安全") } footer: {
                    if faceID { Text("查看会话内容前先通过 Face ID。离开 App 或过十分钟后，再查看时会再次询问。") }
                    else if !faceIDAvailable { Text("这台手机没有设置锁屏密码，无法打开。") }
                    else { Text("关闭时，拿着这台已解锁手机的人可以查看和操作 Mac 上的会话，直到这台手机被移除。") }
                }
                .onAppear { faceIDAvailable = PhoneFaceID.available }
                Section {
                    Toggle("Agent 提问提醒", isOn: $questionReminders)
                    Toggle("其他电脑等你处理时通知", isOn: Binding(get: { notifyOthers }, set: { next in
                        changingNotices = true; noticesRefused = false
                        Task {
                            let granted = await PhoneComputerNotices.change(to: next)
                            notifyOthers = PhoneComputerNotices.isOn; noticesRefused = next && !granted; changingNotices = false
                        }
                    })).disabled(changingNotices)
                } header: { Text("通知") } footer: {
                    if noticesRefused { Text("系统设置里没有允许 Latch 发通知。") }
                    else { Text("使用 Latch 时提醒你回答新问题。支持实时活动的设备也会显示待回答状态。") }
                }
                Section("关于") {
                    LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                    Button(copied ? "已复制" : "复制诊断信息") {
                        UIPasteboard.general.setItems([["public.utf8-plain-text": model.diagnostics()]],
                            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                        copied = true
                    }
                    NavigationLink("开源许可") { LicensesView() }
                }
            }
            .navigationTitle("设置")
        }
    }
}

private struct PhoneHostDetail: View {
    private enum Removal {
        case disconnect, forget
        var action: String { self == .disconnect ? "断开" : "移除" }
    }
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let host: RegisteredHost
    @State private var removal: Removal?
    @State private var working = false
    @State private var failed: Removal?
    private var row: PhoneComputerRow? { model.computerRows.first { $0.id == host.id } }
    private var name: String { row?.name ?? host.name }
    private var connectedHere: Bool { model.selectedHost?.id == host.id && model.connected }
    var body: some View {
        Form {
            Section {
                LabeledContent("名称", value: name)
                LabeledContent("状态", value: PhoneComputers.stateWords(row?.state, lastSeen: row?.lastSeen))
            }
            if !connectedHere {
                Section {
                    Button(row?.state == .online ? "连接这台 Mac" : "重新连接") {
                        Task { await model.retryComputer(host.id) }
                    }.disabled(working || model.busy || row == nil)
                }
            }
            Section {
                if connectedHere {
                    Button("断开这台 Mac", role: .destructive) { removal = .disconnect }.disabled(working)
                } else {
                    Button("从这台设备移除", role: .destructive) { removal = .forget }
                        .disabled(working || model.busy || row == nil)
                }
            } footer: {
                if failed == .disconnect { Text("没有断开。连上这台 Mac 后再试一次。") }
                else if failed == .forget, row != nil { Text("未能完成移除。请根据当前连接状态重试。") }
            }
        }
        .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
        .alert("\(removal?.action ?? "")「\(name)」？", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }),
               presenting: removal) { action in
            Button(action.action, role: .destructive) {
                working = true; failed = nil
                Task {
                    let done = action == .disconnect ? await model.disconnect(host) : await model.forgetComputer(host)
                    working = false
                    if done { dismiss() }
                    else if model.storeState == .ready { failed = action }
                }
            }
            Button("取消", role: .cancel) {}
        } message: { action in
            if action == .disconnect { Text("之后要在 Mac 上重新扫码才能连接。") }
            else { Text("会清除这台设备上保存的连接资料和缓存。Mac 上的设备记录会保留。需要时可以重新扫码连接。") }
        }
    }
}

/** Real platform APIs, called only with a Host-provided challenge hash and a fully enabled Host contract. */
actor NativeAppAttestHook {
    private let service = DCAppAttestService.shared
    func createKey() async throws -> String {
        guard service.isSupported else { throw NativeFailure.unsupported }
        let id = try await service.generateKey()
        guard !id.isEmpty, id.utf8.count <= 512 else { throw NativeFailure.invalidRecord }; return id
    }
    func attest(keyId: String, challengeHash: Data) async throws -> Data {
        guard service.isSupported, challengeHash.count == 32, !keyId.isEmpty, keyId.utf8.count <= 512 else { throw NativeFailure.unsupported }
        let data = try await service.attestKey(keyId, clientDataHash: challengeHash)
        guard data.count <= 262_144 else { throw NativeFailure.invalidRecord }; return data
    }
    func assertion(keyId: String, challengeHash: Data) async throws -> Data {
        guard service.isSupported, challengeHash.count == 32, !keyId.isEmpty, keyId.utf8.count <= 512 else { throw NativeFailure.unsupported }
        let data = try await service.generateAssertion(keyId, clientDataHash: challengeHash)
        guard data.count <= 65_536 else { throw NativeFailure.invalidRecord }; return data
    }
}

@MainActor enum NativePushHook {
    static func requestPermission(hostSupportsPush: Bool) async throws -> Bool {
        guard hostSupportsPush else { throw NativeFailure.unsupported }
        let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }
    static func persistToken(_ token: Data, in vault: EncryptedVault) async throws {
        guard (16...256).contains(token.count) else { throw NativeFailure.invalidRecord }
        try await vault.storeMetadata(token, name: "apns-token")
    }
}

/** 开源许可: the notices and licence texts of what the App carries, read from its own bundle. */
struct LicensesView: View {
    static let files = [("版权与声明", "NOTICE-brands"), ("来源", "SOURCES"), ("Apache License 2.0", "LICENSE-Apache-2.0"), ("LobeHub Icons（MIT）", "LICENSE-lobe-icons")]
    var body: some View {
        List(Self.files, id: \.1) { title, name in
            NavigationLink(title) { LicenseText(title: title, name: name) }
        }.navigationTitle("开源许可").navigationBarTitleDisplayMode(.inline)
    }
}

private struct LicenseText: View {
    let title: String
    let name: String
    var body: some View {
        Group {
            if let text = Bundle.main.url(forResource: name, withExtension: "txt").flatMap({ try? String(contentsOf: $0, encoding: .utf8) }), !text.isEmpty {
                ScrollView {
                    Text(text).font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.ink2).frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .textSelection(.enabled)
                }
            } else {
                ContentUnavailableView("读不到这份文本", systemImage: "doc.questionmark", description: Text("这个安装缺少 \(name).txt"))
            }
        }.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}

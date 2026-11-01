import DeviceCheck
import LatchNativeCore
import SwiftUI
import UserNotifications
import UIKit

struct PhoneSettingsView: View {
    @EnvironmentObject private var model: PhoneModel
    let addComputer: () -> Void
    @State private var copied = false
    var body: some View {
        NavigationStack {
            Form {
                Section("电脑") {
                    ForEach(model.hosts) { host in
                        NavigationLink {
                            PhoneHostDetail(host: host)
                        } label: {
                            LabeledContent(host.name, value: model.selectedHost?.id == host.id ? model.status : "")
                        }
                    }
                    Button("添加电脑", action: addComputer)
                }
                Section("通知") {
                    LabeledContent("状态通知", value: "这台电脑尚未开通")
                }
                Section("关于") {
                    LabeledContent("版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                    Button(copied ? "已复制" : "复制诊断信息") {
                        UIPasteboard.general.setItems([["public.utf8-plain-text": model.diagnostics()]],
                            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                        copied = true
                    }
                }
            }
            .navigationTitle("设置")
        }
    }
}

private struct PhoneHostDetail: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let host: RegisteredHost
    @State private var confirming = false
    @State private var working = false
    @State private var failed = false
    private var current: Bool { model.selectedHost?.id == host.id }
    var body: some View {
        Form {
            Section {
                LabeledContent("名称", value: host.name)
                LabeledContent("状态", value: current && model.connected ? "在线" : "不在线")
            }
            Section {
                Button("断开这台 Mac", role: .destructive) { confirming = true }
                    .disabled(working || !current || !model.connected)
            } footer: {
                if failed { Text("没有断开。连上这台 Mac 后再试一次。") }
                else if !current || !model.connected { Text("连上这台 Mac 后才能断开。") }
            }
        }
        .navigationTitle(host.name).navigationBarTitleDisplayMode(.inline)
        .alert("断开「\(host.name)」？", isPresented: $confirming) {
            Button("断开", role: .destructive) {
                working = true; failed = false
                Task {
                    let done = await model.disconnect(host)
                    working = false; failed = !done
                    if done { dismiss() }
                }
            }
            Button("取消", role: .cancel) {}
        } message: { Text("之后要在 Mac 上重新扫码才能连接。") }
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

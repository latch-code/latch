import CryptoKit
import DeviceCheck
import LatchNativeCore
import SwiftUI
import UserNotifications
import UIKit

struct PhoneSettingsView: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                if let host = model.selectedHost {
                    Section {
                        LabeledContent("连接", value: model.status)
                        Button("暂停所有手机输入", role: .destructive) { Task { await model.pauseInput() } }.disabled(!model.connected)
                    } header: { Text(host.name) } footer: { Text("暂停后仍可查看和停止。恢复输入需要在电脑上确认。") }
                }
                Section("通知") {
                    LabeledContent("状态通知", value: "这台电脑尚未开通")
                }
                Section("文件预览") {
                    Text("文本可直接阅读，PNG/JPEG 在本机重绘后快速查看。PDF、Office 与网页格式尚未完成 iOS 预览验证。").font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    DisclosureGroup("高级诊断") {
                        LabeledContent("硬件密钥", value: SecureEnclave.isAvailable ? "Secure Enclave 可用" : "当前环境不可用")
                        LabeledContent("App Attest", value: DCAppAttestService.shared.isSupported ? "平台支持，电脑尚未启用" : "当前环境不支持")
                        if let until = model.verifiedUntil { LabeledContent("解锁期限") { Text(until, style: .time) } }
                    }
                }
            }
            .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
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

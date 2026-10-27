import AVFoundation
import LatchNativeCore
import SwiftUI
import VisionKit

struct PairingView: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @State private var payload = ""
    @State private var name = "我的电脑"
    @State private var camera = false
    @State private var cameraDenied = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("在 Mac 上打开 Latch → 设置 → 设备与连接，显示手机配对二维码。").foregroundStyle(.secondary)
                    Button("扫描二维码", systemImage: "qrcode.viewfinder") { scan() }
                        .disabled(!DataScannerViewController.isSupported)
                    if cameraDenied { Text("请在系统设置中允许相机权限，或粘贴配对资料。").font(.footnote).foregroundStyle(.secondary) }
                }
                Section("或粘贴配对资料") {
                    SecureField("LATCHPAIR1.…", text: $payload).textInputAutocapitalization(.never).autocorrectionDisabled()
                    LocalTextEditor(text: $name, placeholder: "电脑名称", maximumLines: 1)
                }
                Section {
                    Button("连接这台电脑") {
                        let value = payload.trimmingCharacters(in: .whitespacesAndNewlines); payload = ""
                        Task { await model.beginPairing(payload: value, name: name); if model.draft != nil { dismiss() } }
                    }.disabled(payload.isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
                } footer: {
                    Text("扫描后，在电脑确认即可开始使用。连接会自动选择可用路径。")
                }
            }
            .navigationTitle("添加电脑").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .sheet(isPresented: $camera) { QRScanner { value in payload = value; camera = false } }
        }
    }
    private func scan() {
        Task {
            let allowed = await AVCaptureDevice.requestAccess(for: .video)
            cameraDenied = !allowed
            if allowed, DataScannerViewController.isAvailable { camera = true }
        }
    }
}

private struct QRScanner: UIViewControllerRepresentable {
    let found: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(found: found) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
            recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true,
            isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        do { try controller.startScanning() } catch { context.coordinator.failed = true }
        return controller
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        var failed = false
        private var handled = false
        init(found: @escaping (String) -> Void) { self.found = found }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !handled else { return }
            for item in addedItems {
                if case let .barcode(code) = item, let value = code.payloadStringValue,
                   value.hasPrefix("LATCHPAIR1."), value.utf8.count <= 16_384 {
                    handled = true; dataScanner.stopScanning(); found(value); return
                }
            }
        }
    }
}

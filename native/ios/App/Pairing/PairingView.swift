import AVFoundation
import LatchNativeCore
import SwiftUI
import VisionKit

/** The first screen with no computers. */
struct PairingWelcome: View {
    let scan: () -> Void
    var body: some View {
        VStack(spacing: 20) {
            bundled("LatchMark").resizable().frame(width: 42, height: 42).clipShape(RoundedRectangle(cornerRadius: 10))
            Text("连接你的 Mac").font(.title2.weight(.semibold))
            Text("在 Mac 上的 Latch 中，打开 手机 › 连接手机。").foregroundStyle(.secondary).multilineTextAlignment(.center)
            Text("连接后，拿着这台解锁手机的人可以操作 Mac 上的 Agent，直到你移除它。").font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("扫码", action: scan).buttonStyle(.borderedProminent).controlSize(.large)
        }.frame(maxWidth: .infinity)
    }
}

/** Scanner, connecting, confirm on the Mac, connected, or one error with one action. */
struct PairingView: View {
    @EnvironmentObject private var model: PhoneModel
    let close: () -> Void
    var body: some View {
        content.onChange(of: model.pairing) { previous, next in
            if case .connected = previous, next == nil { close() }
        }
    }
    @ViewBuilder private var content: some View {
        switch model.pairing {
        case nil: PairingScanner(close: close)
        case .connecting:
            PairingStep {
                ProgressView().controlSize(.large)
                Text("正在连接 Mac…").font(.title3.weight(.semibold))
                Button("取消") { model.cancelPairing(); close() }
            }
        case .confirming:
            PairingStep {
                Image(systemName: "laptopcomputer").font(.system(size: 44)).foregroundStyle(.secondary)
                Text("在 Mac 上确认").font(.title2.weight(.semibold))
                Text("用 Touch ID 允许这台 iPhone。").foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("取消") { model.cancelPairing(); close() }
            }
        case let .connected(name):
            PairingStep {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 44)).foregroundStyle(.tint)
                Text("已连接「\(name)」").font(.title3.weight(.semibold)).multilineTextAlignment(.center)
            }
        case let .failed(failure):
            PairingStep {
                Text(failure.title).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                if let message = failure.message { Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center) }
                switch failure {
                case .localNetworkDenied:
                    Button("打开设置") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        model.dismissPairingFailure(); close()
                    }.buttonStyle(.borderedProminent)
                case .hostTooOld:
                    Button("好") { model.dismissPairingFailure(); close() }.buttonStyle(.borderedProminent)
                default:
                    Button("重新扫码") { model.dismissPairingFailure() }.buttonStyle(.borderedProminent)
                }
            }
        }
    }
}

private struct PairingStep<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 20) { content }.padding(32).frame(maxWidth: 460, maxHeight: .infinity)
    }
}

private struct PairingScanner: View {
    @EnvironmentObject private var model: PhoneModel
    let close: () -> Void
    @State private var allowed: Bool?
    @State private var foreign = false
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if allowed == true, DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
                QRScanner { value in
                    if PairingInvitation.recognizes(value) { Task { await model.beginPairing(payload: value) } }
                    else { foreign = true }
                }.ignoresSafeArea()
            } else if allowed == false {
                VStack(spacing: 16) {
                    Text("需要相机权限").font(.title3.weight(.semibold))
                    Text("在“设置”里允许 Latch 使用相机，才能扫描 Mac 上的二维码。").multilineTextAlignment(.center)
                    Button("打开设置") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                        .buttonStyle(.borderedProminent)
                }.foregroundStyle(.white).padding(32)
            }
            VStack {
                Text(foreign ? "这不是 Latch 的二维码" : "对准 Mac 上的二维码").foregroundStyle(.white).padding(.top, 24)
                Spacer()
                HStack(spacing: 12) {
                    // A device without a camera takes the same code from the clipboard, checked as a scanned one is.
                    PasteButton(payloadType: String.self) { values in
                        guard let value = values.first, value.utf8.count <= 16_384 else { return }
                        let count = UIPasteboard.general.changeCount
                        Task { @MainActor in
                            if PairingInvitation.recognizes(value) { model.pastedPairing = count; await model.beginPairing(payload: value) }
                            else { foreign = true }
                        }
                    }.labelStyle(.titleAndIcon).buttonBorderShape(.capsule).tint(.white)
                    Button("取消", action: close).buttonStyle(.bordered).tint(.white)
                }.padding(.bottom, 24)
            }
        }
        .task { allowed = await AVCaptureDevice.requestAccess(for: .video) }
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
                guard case let .barcode(code) = item, let value = code.payloadStringValue, value.utf8.count <= 16_384 else { continue }
                if PairingInvitation.recognizes(value) { handled = true; dataScanner.stopScanning() }
                found(value)
                return
            }
        }
    }
}

import LatchNativeCore
import SwiftUI
import UIKit

/** The product's colour tokens, in the words of the desktop's: blue is for execution and ticks, amber for what waits on you, red for real failure. */
enum PhoneTheme {
    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        func color(_ value: UInt32) -> UIColor {
            UIColor(red: CGFloat(value >> 16 & 255) / 255, green: CGFloat(value >> 8 & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        }
        return Color(UIColor { $0.userInterfaceStyle == .dark ? color(dark) : color(light) })
    }
    static let ink = dynamic(0x18181B, 0xF4F4F5)
    static let ink2 = dynamic(0x3F3F46, 0xD4D4D8)
    static let muted = dynamic(0x6A6A73, 0xA1A1AA)
    static let faint = dynamic(0xA1A1AA, 0x71717A)
    static let canvas = dynamic(0xFFFFFF, 0x111113)
    static let raised = dynamic(0xFFFFFF, 0x18181B)
    static let sunken = dynamic(0xF7F7F8, 0x0E0E10)
    static let bubble = dynamic(0xF1F1F3, 0x1E1E21)
    static let line = dynamic(0xEBEBED, 0x2A2A2D)
    static let lineStrong = dynamic(0xDCDCE0, 0x38383B)
    static let accent = dynamic(0x2461E0, 0x2F6FEB)
    static let amber = dynamic(0xB45309, 0xFBBF24)
    static let amberIcon = dynamic(0xD47306, 0xFBBF24)
    static let red = dynamic(0xB91C1C, 0xF87171)
    static let green = dynamic(0x15803D, 0x4ADE80)
    static let body = Font.system(size: 16)
    static let row = Font.system(size: 15, weight: .medium)
    static let caption = Font.system(size: 13)
    static let mono = Font.system(size: 14, design: .monospaced)

    /** 我的 Agent's hues, the web's --agent-* tokens: muted, never red, orange, yellow, bright green or bright blue. */
    private static let agentHues: [String: (light: UInt32, dark: UInt32)] = [
        "neutral": (0x6B6B74, 0x9A9AA4), "ink": (0x3D4049, 0xB4B8C2), "slate": (0x5F7389, 0x8599B0), "pine": (0x4E7A68, 0x6FA18B),
        "plum": (0x8A5A7A, 0xB582A5), "wisteria": (0x7A72B8, 0x9D96D9), "cocoa": (0x8A6A55, 0xB08E77), "sand": (0xA88C5E, 0xC6AA7A),
        "moss": (0x7E8E5E, 0xA0B07E), "mist": (0x7F96AE, 0xA0B6CD),
    ]
    static func agentHue(_ hue: String) -> Color {
        let pair = agentHues[hue] ?? agentHues["neutral"]!
        return dynamic(pair.light, pair.dark)
    }
    /** The face's plate: 13% of the hue over the canvas, as the web mixes it over the surface. */
    static func agentPlate(_ hue: String) -> Color {
        let pair = agentHues[hue] ?? agentHues["neutral"]!
        func mix(_ value: UInt32, _ ground: UInt32) -> UInt32 {
            [16, 8, 0].reduce(UInt32(0)) { result, shift in
                let top = Double(value >> UInt32(shift) & 255), base = Double(ground >> UInt32(shift) & 255)
                return result | UInt32((top * 0.13 + base * 0.87).rounded()) << UInt32(shift)
            }
        }
        return dynamic(mix(pair.light, 0xFFFFFF), mix(pair.dark, 0x111113))
    }
}

/** These marks are loose files in the bundle, which SwiftUI's named images do not look through. */
func bundled(_ name: String) -> Image { UIImage(named: name).map(Image.init(uiImage:)) ?? Image(systemName: "cpu") }

/** An engine's own mark, the app's own icon for the built-in engine, or a neutral glyph. Never a letter. */
struct EngineTile: View {
    /** The Host's key for its icon; nil draws the neutral glyph. */
    let mark: String?
    var size: CGFloat = 16
    @Environment(\.colorScheme) private var scheme
    private static let marks: [String: (light: String, dark: String, mono: Bool)] = [
        "codex": ("brand-codex", "brand-codex", true), "pi": ("brand-pi", "brand-pi", false),
        "opencode": ("brand-opencode-light", "brand-opencode-dark", false), "dsh": ("brand-deepseek-harness", "brand-deepseek-harness", true),
        "gemini": ("brand-gemini", "brand-gemini", false), "qwen": ("brand-qwen-code", "brand-qwen-code", false), "goose": ("brand-goose", "brand-goose", true),
    ]
    var body: some View {
        Group {
            if mark == "latch" {
                bundled("LatchMark").resizable().interpolation(.high).clipShape(RoundedRectangle(cornerRadius: size * 0.22))
                    // Its charcoal tile would merge with a dark ground.
                    .overlay { if scheme == .dark { RoundedRectangle(cornerRadius: size * 0.22).stroke(PhoneTheme.lineStrong, lineWidth: 0.5) } }
            } else if let mark = mark.flatMap({ Self.marks[$0] }) {
                bundled(scheme == .dark ? mark.dark : mark.light).resizable().renderingMode(mark.mono ? .template : .original).interpolation(.high)
                    .foregroundStyle(PhoneTheme.ink)
            } else {
                Image(systemName: "cpu").resizable().scaledToFit().foregroundStyle(PhoneTheme.muted)
            }
        }.frame(width: size, height: size).accessibilityHidden(true)
    }
}

/** A session's engine by the catalog. */
extension PhoneModel {
    func engineInfo(_ harnessId: String?) -> NativeJSON {
        snapshot["catalog"]["harnesses"].array.first { $0["id"].string == harnessId } ?? .null
    }
    func engineMark(_ harnessId: String?) -> String? {
        let info = engineInfo(harnessId)
        return info != .null ? PhoneStart.mark(info) : harnessId.map(PhoneStart.removedMark)
    }
    func engineName(_ harnessId: String?) -> String {
        let info = engineInfo(harnessId)
        if info != .null { return PhoneStart.engineName(info) }
        // A session keeps the identifier of an engine since removed, and should not read as if another ran it.
        return harnessId ?? "Harness"
    }
}

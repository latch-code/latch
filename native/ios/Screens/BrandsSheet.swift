import SwiftUI

/** Every engine mark at 16, 20 and 24 pt, for the brands crop sheet. Only the LatchScreens target compiles this. */
struct BrandsSheet: View {
    private let marks = ["codex", "pi", "opencode", "dsh", "gemini", "qwen", "goose", "latch"]
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(marks, id: \.self) { mark in
                HStack(spacing: 18) {
                    Text(mark).font(.system(size: 13, design: .monospaced)).frame(width: 80, alignment: .leading)
                    ForEach([16, 20, 24] as [CGFloat], id: \.self) { size in EngineTile(mark: mark, size: size).frame(width: 32) }
                    HStack(spacing: 6) { EngineTile(mark: mark, size: 14); Text(mark == "codex" ? "Codex · gpt-5" : mark).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                }
            }
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(PhoneTheme.canvas)
    }
}

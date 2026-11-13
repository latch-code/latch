import SwiftUI

/** Every engine mark at 14, 16, 20 and 24 pt, for the brands crop sheet. Only the LatchScreens target compiles this. */
struct BrandsSheet: View {
    private let marks = ["latch", "codex", "claude-agent", "gemini", "qwen", "goose", "cursor", "pi", "dsh", "opencode", "grok", "antigravity"]
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(marks, id: \.self) { mark in
                HStack(spacing: 12) {
                    Text(mark).font(.system(size: 13, design: .monospaced)).frame(width: 90, alignment: .leading)
                    ForEach([14, 16, 20, 24] as [CGFloat], id: \.self) { size in EngineTile(mark: mark, size: size).frame(width: 32) }
                }
            }
        }
        .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(PhoneTheme.canvas)
    }
}

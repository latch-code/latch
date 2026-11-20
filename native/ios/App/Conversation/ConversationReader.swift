import LatchNativeCore
import SwiftUI

private enum ConversationAnchor: Hashable { case latest }

struct ConversationReader<Content: View>: View {
    let session: String
    let contentEpoch: UUID
    let offersTurnIndex: Bool
    @ViewBuilder var content: Content
    @Namespace private var viewport
    @State private var away = false
    @State private var movement = ReadingMovement()
    @State private var choosingTurn = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { reader in
            VStack(spacing: 0) {
                GeometryReader { bounds in
                    ScrollView {
                        VStack(spacing: 0) {
                            content
                            Color.clear.frame(height: 1).id(ConversationAnchor.latest).accessibilityHidden(true)
                        }
                        .background {
                            GeometryReader { transcript in
                                Color.clear.preference(key: TranscriptGeometry.self, value: TranscriptFrame(
                                    content: transcript.frame(in: .named(viewport)), viewport: bounds.size.height))
                            }
                        }
                    }
                    .coordinateSpace(name: viewport)
                    .defaultScrollAnchor(away ? nil : .bottom)
                    .readingGestures(movement)
                    .onPreferenceChange(TranscriptGeometry.self) { frame in
                        guard let frame else { return }
                        let prior = movement.last
                        movement.last = frame
                        let resized = prior?.height != frame.height || prior?.viewport != frame.viewport
                        if frame.gap <= 48 { away = false }
                        else if frame.gap > 72, movement.scrolling || (!resized && frame.offset < (prior?.offset ?? frame.offset)) {
                            away = true
                        }
                        if resized && !away && !movement.scrolling && frame.gap > 1 {
                            // A late card or a growing reply moves the end without any gesture from the reader.
                            reader.scrollTo(ConversationAnchor.latest, anchor: .bottom)
                        }
                    }
                }
                .clipped()
                if away {
                    HStack(spacing: 16) {
                        if offersTurnIndex {
                            Button { choosingTurn = true } label: { Label("定位提问", systemImage: "list.bullet") }
                        }
                        Button {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                                reader.scrollTo(ConversationAnchor.latest, anchor: .bottom)
                            }
                        } label: { Label("回到最新", systemImage: "arrow.down") }
                    }
                    .font(.subheadline.weight(.medium)).buttonStyle(ReadingButtonStyle())
                    .frame(maxWidth: .infinity)
                }
            }
            .sheet(isPresented: $choosingTurn) {
                QuestionIndex(session: session, contentEpoch: contentEpoch) { turn in
                    choosingTurn = false
                    reader.scrollTo(turn, anchor: .top)
                }
                .presentationDetents([.medium, .large])
            }
        }
    }
}

private struct TranscriptFrame: Equatable {
    let height: CGFloat, viewport: CGFloat, offset: CGFloat
    var gap: CGFloat { height - offset - viewport }
    init(content: CGRect, viewport: CGFloat) {
        height = content.height.rounded(); offset = -content.minY.rounded(); self.viewport = viewport.rounded()
    }
}

private final class ReadingMovement {
    var last: TranscriptFrame?
    var scrolling = false
}

private extension View {
    @ViewBuilder func readingGestures(_ movement: ReadingMovement) -> some View {
        if #available(iOS 18, *) {
            onScrollPhaseChange { _, phase in
                movement.scrolling = phase == .tracking || phase == .interacting || phase == .decelerating
            }
        } else { self }
    }
}

private enum TranscriptGeometry: PreferenceKey {
    static var defaultValue: TranscriptFrame? { nil }
    static func reduce(value: inout TranscriptFrame?, nextValue: () -> TranscriptFrame?) { value = nextValue() ?? value }
}

private struct ReadingButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(PhoneTheme.ink2)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(configuration.isPressed ? PhoneTheme.bubble : PhoneTheme.raised, in: Capsule())
            .overlay { Capsule().stroke(PhoneTheme.line) }
            .frame(minHeight: 44).contentShape(Rectangle())
    }
}

private struct QuestionIndex: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let session: String
    let contentEpoch: UUID
    let select: (String) -> Void
    private var available: Bool {
        model.hasContentWindow && model.privateSnapshot.accepts(contentEpoch)
            && model.sessionId == session && model.detail["summary"]["id"].string == session
    }

    var body: some View {
        NavigationStack {
            List {
                if available {
                    let turns = PhoneConversation.turns(PhoneConversation.rendered(model.detail))
                    ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                        if let user = turn.user {
                            Button {
                                guard available else { return }
                                select(turn.id)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("第 \(index + 1) 轮").font(.caption).foregroundStyle(PhoneTheme.muted)
                                    let prompt = PhoneHistory.fold(user)?.rest ?? user["text"].string ?? ""
                                    Text(prompt.isEmpty ? "查看这一轮" : PhoneConversation.visible(String(prompt.prefix(120))))
                                        .foregroundStyle(PhoneTheme.ink).lineLimit(2)
                                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("定位提问").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
        .onChange(of: available, initial: true) { _, current in if !current { dismiss() } }
    }
}

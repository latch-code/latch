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
            GeometryReader { bounds in
                ScrollView {
                    VStack(spacing: 0) {
                        content
                        Color.clear.frame(height: 1).id(ConversationAnchor.latest).accessibilityHidden(true)
                    }
                    .background {
                        GeometryReader { transcript in
                            let frame = transcript.frame(in: .named(viewport))
                            Color.clear.preference(key: TranscriptGeometry.self, value: PhoneTranscriptFrame(
                                contentHeight: frame.height, viewportHeight: bounds.size.height, offset: -frame.minY))
                        }
                    }
                }
                .coordinateSpace(name: viewport)
                .defaultScrollAnchor(away ? nil : .bottom)
                .readingGestures(movement)
                .onPreferenceChange(TranscriptGeometry.self) { frame in
                    guard let frame else { return }
                    let position = frame.position(after: movement.last, away: away, scrolling: movement.scrolling)
                    movement.last = frame
                    if away != position.away { away = position.away }
                    if position.followEnd { reader.scrollTo(ConversationAnchor.latest, anchor: .bottom) }
                }
                .clipped()
                .overlay(alignment: .bottom) {
                    ZStack {
                        if away {
                            readingControls(reader)
                                .frame(maxWidth: .infinity)
                                .background {
                                    LinearGradient(stops: [
                                        .init(color: PhoneTheme.canvas.opacity(0), location: 0),
                                        .init(color: PhoneTheme.canvas, location: 0.68),
                                        .init(color: PhoneTheme.canvas, location: 1),
                                    ], startPoint: .top, endPoint: .bottom)
                                    .padding(.top, -12)
                                    .allowsHitTesting(false).accessibilityHidden(true)
                                }
                                .transition(.asymmetric(insertion: .opacity, removal: .identity))
                        }
                    }
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: away)
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
    private func readingControls(_ reader: ScrollViewProxy) -> some View {
        HStack(spacing: 0) {
            if offersTurnIndex {
                Button { choosingTurn = true } label: {
                    Label("定位提问", systemImage: "list.bullet")
                        .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                Rectangle().fill(PhoneTheme.line).frame(width: 1, height: 14).accessibilityHidden(true)
            }
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    reader.scrollTo(ConversationAnchor.latest, anchor: .bottom)
                }
            } label: {
                Label("回到最新", systemImage: "arrow.down")
                    .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
        }
        .font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.ink2).buttonStyle(.plain)
        .background {
            Capsule().fill(PhoneTheme.raised).overlay { Capsule().strokeBorder(PhoneTheme.line) }
                .padding(.vertical, 6).shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                .allowsHitTesting(false)
        }
    }
}

private final class ReadingMovement {
    var last: PhoneTranscriptFrame?
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
    static var defaultValue: PhoneTranscriptFrame? { nil }
    static func reduce(value: inout PhoneTranscriptFrame?, nextValue: () -> PhoneTranscriptFrame?) { value = nextValue() ?? value }
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

import LatchNativeCore
import SwiftUI

private enum ConversationAnchor: Hashable { case latest }

struct ConversationReader<Content: View>: View {
    let session: String
    let contentEpoch: UUID
    let offersTurnIndex: Bool
    var submittedPrompt: String? = nil
    @ViewBuilder var content: Content
    @Namespace private var viewport
    @State private var away = false
    @State private var movement = ReadingMovement()
    @State private var choosingTurn = false
    @State private var pendingTurn: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if #available(iOS 18, *) {
            ModernConversationReader(session: session, contentEpoch: contentEpoch, offersTurnIndex: offersTurnIndex,
                submittedPrompt: submittedPrompt, content: { content })
        } else {
            legacyBody
        }
    }

    private var legacyBody: some View {
        ScrollViewReader { reader in
            GeometryReader { bounds in
                ScrollView {
                    VStack(spacing: 0) {
                        content
                        Color.clear.frame(height: 1).id(ConversationAnchor.latest).accessibilityHidden(true)
                    }
                    .environment(\.revealTurn, RevealTurn(session: session) { turn in
                        movement.jumpingToLatest = false
                        away = true
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { reader.scrollTo(turn, anchor: .top) }
                    })
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
                .onChange(of: submittedPrompt) { _, request in
                    guard request != nil else { return }
                    jumpToLatest(reader, animated: false)
                }
                .onPreferenceChange(TranscriptGeometry.self) { frame in
                    guard let frame else { return }
                    apply(frame, reader: reader)
                }
                .clipped()
                .overlay(alignment: .bottom) {
                    ReadingControlsOverlay(away: away, offersTurnIndex: offersTurnIndex, reduceMotion: reduceMotion,
                        openIndex: {
                            PhoneKeyboard.dismiss()
                            choosingTurn = true
                        },
                        toLatest: { jumpToLatest(reader, animated: true) })
                }
            }
            .sheet(isPresented: $choosingTurn, onDismiss: {
                guard let turn = pendingTurn else { return }
                pendingTurn = nil
                reader.scrollTo(turn, anchor: .top)
            }) {
                QuestionIndex(session: session, contentEpoch: contentEpoch) { turn in
                    movement.jumpingToLatest = false
                    away = true
                    pendingTurn = turn
                    choosingTurn = false
                    reader.scrollTo(turn, anchor: .top)
                }
                .presentationDetents([.medium, .large])
            }
        }
    }

    private func jumpToLatest(_ reader: ScrollViewProxy, animated: Bool) {
        let token = movement.beginJumpToLatest()
        away = false
        if animated && !reduceMotion {
            withAnimation(.easeOut(duration: 0.2)) {
                reader.scrollTo(ConversationAnchor.latest, anchor: .bottom)
            }
        } else {
            reader.scrollTo(ConversationAnchor.latest, anchor: .bottom)
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(animated && !reduceMotion ? 320 : 120))
            guard movement.jumpToken == token, movement.jumpingToLatest else { return }
            movement.jumpingToLatest = false
            if !away, let last = movement.last, !last.isAtEnd {
                reader.scrollTo(ConversationAnchor.latest, anchor: .bottom)
            }
        }
    }

    private func apply(_ frame: PhoneTranscriptFrame, reader: ScrollViewProxy) {
        if movement.jumpingToLatest {
            movement.last = frame
            if frame.isAtEnd { movement.jumpingToLatest = false }
            return
        }
        let position = frame.position(after: movement.last, away: away, scrolling: movement.scrolling)
        movement.last = frame
        if away != position.away { away = position.away }
        if position.followEnd { reader.scrollTo(ConversationAnchor.latest, anchor: .bottom) }
    }
}

@available(iOS 18, *)
private struct ModernConversationReader<Content: View>: View {
    let session: String
    let contentEpoch: UUID
    let offersTurnIndex: Bool
    let submittedPrompt: String?
    @ViewBuilder let content: () -> Content
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @State private var away = false
    @State private var movement = ReadingMovement()
    @State private var choosingTurn = false
    @State private var pendingTurn: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                VStack(spacing: 0) {
                    content()
                    Color.clear.frame(height: 1).id(ConversationAnchor.latest).accessibilityHidden(true)
                }
                .environment(\.revealTurn, RevealTurn(session: session) { turn in
                    movement.jumpingToLatest = false
                    away = true
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { reader.scrollTo(turn, anchor: .top) }
                })
            }
            .scrollPosition($scrollPosition)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(away ? nil : .bottom, for: .sizeChanges)
            .onScrollPhaseChange { _, phase in
                movement.scrolling = phase == .interacting || phase == .decelerating
                if phase == .interacting {
                    movement.jumpingToLatest = false
                } else if phase == .idle, movement.jumpingToLatest {
                    movement.jumpingToLatest = false
                    if !away, let last = movement.last, !last.isAtEnd {
                        scrollPosition.scrollTo(edge: .bottom)
                    }
                }
            }
            .onScrollGeometryChange(for: PhoneTranscriptFrame.self) { geometry in
                PhoneTranscriptFrame(
                    contentHeight: geometry.contentSize.height,
                    viewportHeight: geometry.containerSize.height,
                    offset: geometry.contentOffset.y + geometry.contentInsets.top)
            } action: { _, frame in
                if movement.jumpingToLatest {
                    movement.last = frame
                    if frame.isAtEnd { movement.jumpingToLatest = false }
                    return
                }
                let position = frame.position(after: movement.last, away: away, scrolling: movement.scrolling)
                movement.last = frame
                if away != position.away { away = position.away }
                if position.followEnd { scrollPosition.scrollTo(edge: .bottom) }
            }
            .onChange(of: submittedPrompt) { _, request in
                guard request != nil else { return }
                jumpToLatest(animated: false)
            }
            .clipped()
            .overlay(alignment: .bottom) {
                ReadingControlsOverlay(away: away, offersTurnIndex: offersTurnIndex, reduceMotion: reduceMotion,
                    openIndex: {
                        PhoneKeyboard.dismiss()
                        choosingTurn = true
                    },
                    toLatest: { jumpToLatest(animated: true) })
            }
            .sheet(isPresented: $choosingTurn, onDismiss: {
                guard let turn = pendingTurn else { return }
                pendingTurn = nil
                reader.scrollTo(turn, anchor: .top)
            }) {
                QuestionIndex(session: session, contentEpoch: contentEpoch) { turn in
                    movement.jumpingToLatest = false
                    away = true
                    pendingTurn = turn
                    choosingTurn = false
                    reader.scrollTo(turn, anchor: .top)
                }
                .presentationDetents([.medium, .large])
            }
        }
    }

    private func jumpToLatest(animated: Bool) {
        let token = movement.beginJumpToLatest()
        away = false
        if animated && !reduceMotion {
            withAnimation(.easeOut(duration: 0.2)) {
                scrollPosition.scrollTo(edge: .bottom)
            }
        } else {
            scrollPosition.scrollTo(edge: .bottom)
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(animated && !reduceMotion ? 320 : 120))
            guard movement.jumpToken == token, movement.jumpingToLatest else { return }
            movement.jumpingToLatest = false
            if !away, let last = movement.last, !last.isAtEnd {
                scrollPosition.scrollTo(edge: .bottom)
            }
        }
    }
}

private struct ReadingControlsOverlay: View {
    let away: Bool
    let offersTurnIndex: Bool
    let reduceMotion: Bool
    let openIndex: () -> Void
    let toLatest: () -> Void

    var body: some View {
        ZStack {
            if away {
                HStack(spacing: 0) {
                    if offersTurnIndex {
                        Button(action: openIndex) {
                            Label("定位提问", systemImage: "list.bullet")
                                .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        Rectangle().fill(PhoneTheme.line).frame(width: 1, height: 14).accessibilityHidden(true)
                    }
                    Button(action: toLatest) {
                        Label("回到最新", systemImage: "arrow.down")
                            .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                }
                .font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.ink2).buttonStyle(ReadingPillButtonStyle())
                .background {
                    Capsule().fill(PhoneTheme.raised).overlay { Capsule().strokeBorder(PhoneTheme.line) }
                        .padding(.vertical, 6).shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                        .allowsHitTesting(false)
                }
                .background(KeyboardDismissExclusion())
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

private struct ReadingPillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.55 : 1)
    }
}

private extension PhoneTranscriptFrame {
    var isAtEnd: Bool {
        !position(after: nil, away: false, scrolling: false).followEnd
    }
}

private final class ReadingMovement {
    var last: PhoneTranscriptFrame?
    var scrolling: Bool? = if #available(iOS 18, *) { false } else { nil }
    var jumpingToLatest = false
    var jumpToken = 0

    func beginJumpToLatest() -> Int {
        jumpToken += 1
        jumpingToLatest = true
        return jumpToken
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

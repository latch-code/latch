import LatchNativeCore
import SwiftUI

struct WorkSourceView: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let source: PhoneWorkSource
    let stamp: PhoneWorkReadStamp

    var body: some View {
        if stamp == model.workStamp(itemId), model.workDestinationAllowed(.source(source), itemId: itemId) {
            ConversationView(id: source.sessionId, work: PhoneWorkDecisionContext(itemId: itemId, source: source, stamp: stamp,
                navigation: model.workPathGeneration))
                .navigationTitle("原回合")
                .task(id: stamp) { await model.openWorkSession(source.sessionId, itemId: itemId, destination: .source(source)) }
        } else {
            ContentUnavailableView(model.workSourceVisibility(source.sessionId).notice ?? "原会话不可用", systemImage: "bubble.left")
        }
    }
}

struct WorkSessionPage: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let sessionId: String

    var body: some View {
        if model.workStamp(itemId) != nil, model.workDestinationAllowed(.session(sessionId), itemId: itemId) {
            ConversationView(id: sessionId)
                .task(id: sessionId) { await model.openWorkSession(sessionId, itemId: itemId, destination: .session(sessionId)) }
        } else {
            ContentUnavailableView("会话不可用", systemImage: "bubble.left")
        }
    }
}

struct WorkReplyView: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let stamp: PhoneWorkReadStamp
    let postId: String
    let messageId: String
    let source: PhoneWorkSource
    @State private var turn: PhoneWorkTurn?
    @State private var text = ""
    @State private var offset: Int? = 0
    @State private var failure: String?
    @State private var loading = false

    private var destination: PhoneWorkDestination { .reply(post: postId, message: messageId, source: source) }

    private var readable: Bool {
        stamp == model.workStamp(itemId) && model.workDestinationAllowed(destination, itemId: itemId)
    }

    var body: some View {
        WorkPage(title: "完整回复") {
            if readable {
                if let item = model.workItem(itemId) {
                    Label(PhoneConversation.visible(item.title), systemImage: "checklist").font(.subheadline).foregroundStyle(PhoneTheme.muted)
                }
                if let turn {
                    WorkRouteLink(title: "查看原回合", icon: "arrow.turn.down.right",
                        destination: .source(PhoneWorkSource(sessionId: turn.sessionId, anchor: .turn(turn, source.decision))), subrow: true)
                }
                if !text.isEmpty { MarkdownView(text: PhoneConversation.visible(text)) }
                if let failure {
                    WorkReadNotice(title: failure) { if let offset { await load(offset) } }
                } else if loading {
                    WorkLoading(label: "正在读取回复…")
                } else if let offset, offset > 0 {
                    Button("继续阅读", systemImage: "arrow.down") { Task { await load(offset) } }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                }
            } else if model.connected {
                WorkReadNotice(title: model.workSourceVisibility(source.sessionId).notice ?? "回复暂不可用")
            }
        }
        .task(id: stamp) { if readable && offset == 0 { await load(0) } }
        .onChange(of: readable) { _, readable in
            if !readable { text = ""; turn = nil; offset = 0; failure = nil }
        }
    }
    private func load(_ start: Int) async {
        guard !loading, offset == start, readable else { return }
        let navigation = model.workPathGeneration
        loading = true; failure = nil
        defer { loading = false }
        do {
            let value = try await model.readWork(.reply(itemId, post: postId, message: messageId, offset: start),
                itemId: itemId, stamp: stamp, destination: destination)
            let page = try PhoneWorkReplyPage(value, messageId: messageId, source: source, offset: start)
            guard readable, model.workPathGeneration == navigation, model.workPath.last == destination, !Task.isCancelled else { return }
            guard turn == nil || turn == page.turn else { throw PhoneWorkReadFailure.replyMissing }
            model.publishWork(stamp, itemId: itemId) { turn = page.turn; text += page.text; offset = page.nextOffset }
        } catch {
            guard readable, model.workPathGeneration == navigation, model.workPath.last == destination, !Task.isCancelled, !(error is CancellationError) else { return }
            model.publishWork(stamp, itemId: itemId) {
                if (error as? PhoneWorkReadFailure) == .replyMissing { text = ""; turn = nil }
                failure = workReadWords(error, fallback: "读不到这条回复")
            }
        }
    }
}

struct WorkPage<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                WorkConnectionLine()
                content
            }.padding(18).frame(maxWidth: 780, alignment: .leading).frame(maxWidth: .infinity)
        }.background(PhoneTheme.canvas).navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}

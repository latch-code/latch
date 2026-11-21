import LatchNativeCore
import SwiftUI

/**
 * A team's results, in place of the person's bubble the Host's message would be (the web's `TeamResults`): a row per
 * member with its Harness, name, first line and how it ended; a row opens to that member's whole reply, read from its
 * own session, with 打开会话. The message as it was sent waits behind 发给 Agent 的原文.
 */
struct TeamResultsView: View {
    @EnvironmentObject private var model: PhoneModel
    let message: NativeJSON
    let card: PhoneTeamReturn.Card
    @State private var opened: Set<String> = []
    @State private var source = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Label(card.title, systemImage: "person.2").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
            ForEach(card.rows) { row in
                VStack(alignment: .leading, spacing: 0) {
                    Button { if row.sessionId != nil { withAnimation(.easeOut(duration: 0.2)) { toggle(row.itemId) } } } label: { head(row) }
                        .buttonStyle(.plain).disabled(row.sessionId == nil)
                        .accessibilityValue(row.sessionId == nil ? "" : opened.contains(row.itemId) ? "已展开" : "已折叠")
                    if opened.contains(row.itemId), let session = row.sessionId {
                        MemberReplyView(sessionId: session, requestId: row.requestId)
                            .padding(.horizontal, 12).padding(.bottom, 10).transition(.opacity)
                    }
                }
            }
            Button { withAnimation(.easeOut(duration: 0.2)) { source.toggle() } } label: {
                HStack(spacing: 8) {
                    chevron(source)
                    Text("发给 Agent 的原文").font(.system(size: 14)).foregroundStyle(PhoneTheme.muted)
                    Spacer(minLength: 0)
                }.padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(source ? "已展开" : "已折叠")
            if source {
                ConversationText(text: PhoneConversation.visible(message["text"].string ?? ""), size: 14)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal, 12).padding(.bottom, 12)
            }
        }
        .background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(PhoneTheme.line))
    }
    private func toggle(_ id: String) { if opened.contains(id) { opened.remove(id) } else { opened.insert(id) } }
    private func chevron(_ open: Bool) -> some View {
        Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(PhoneTheme.faint)
            .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 12)
    }
    private func head(_ row: PhoneTeamReturn.Row) -> some View {
        let open = opened.contains(row.itemId)
        return HStack(spacing: 8) {
            if row.sessionId != nil { chevron(open) } else { Color.clear.frame(width: 12) }
            EngineTile(mark: model.engineMark(row.harnessId), size: 16)
            Text(PhoneConversation.visible(row.name)).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink).lineLimit(1).layoutPriority(1)
            if !open, let said = row.state == "unstarted" ? row.refusal : row.said {
                Text(PhoneConversation.visible(said)).font(.system(size: 14)).foregroundStyle(row.state == "unstarted" ? PhoneTheme.amber : PhoneTheme.muted).lineLimit(1)
            }
            Spacer(minLength: 6)
            MemberStateWord(state: row.state)
        }.padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle())
    }
}

/** How a member ended, in the tone the web gives it: blue at work, amber waiting, red failed, a tick when done. */
struct MemberStateWord: View {
    let state: String
    var body: some View {
        HStack(spacing: 4) {
            switch state {
            case "running", "starting": ProgressView().controlSize(.mini).tint(PhoneTheme.accent)
            case "done": Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
            case "failed": Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
            default: EmptyView()
            }
            Text(PhoneTeamReturn.words(state))
        }
        .font(.system(size: 13)).foregroundStyle(tone).lineLimit(1).fixedSize()
    }
    private var tone: Color {
        switch state {
        case "running", "starting": PhoneTheme.accent
        case "waiting": PhoneTheme.amber
        case "failed": PhoneTheme.red
        case "done": PhoneTheme.ink2
        default: PhoneTheme.muted
        }
    }
}

/** A member's whole reply to the round, read from its own session when its row opens. */
private struct MemberReplyView: View {
    @EnvironmentObject private var model: PhoneModel
    let sessionId: String
    let requestId: String?
    @State private var reply: Result<String, PhoneMemberReplyFailure>?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch reply {
            case nil: HStack(spacing: 6) { ProgressView().controlSize(.small); Text("读取中") }.font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            case let .failure(failure): Text(failure.words).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            case let .success(text) where text.isEmpty: Text("没有回复").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            case let .success(text): MarkdownView(text: text, size: 15)
            }
            Button("打开会话") { Task { await model.openSession(sessionId) } }
                .font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.ink2)
                .padding(.horizontal, 10).frame(height: 30).background(PhoneTheme.bubble, in: Capsule())
                .buttonStyle(.plain)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 10))
        .task(id: sessionId + (requestId ?? "")) { reply = await model.memberReply(session: sessionId, requestId: requestId) }
    }
}

struct PhoneMemberReplyFailure: Error, Equatable { let words: String }

extension PhoneModel {
    /** A team member's reply, read through the window already open; a closed window says so rather than asking for one. */
    func memberReply(session: String, requestId: String?) async -> Result<String, PhoneMemberReplyFailure> {
        #if LATCH_SCREENS
        if staged { return .success(PhoneTeamReturn.reply(stagedMemberSessions[session] ?? [], requestId: requestId)) }
        #endif
        guard hasContentWindow, let workspace else { return .failure(PhoneMemberReplyFailure(words: "打开会话后可以看到它的回复")) }
        do {
            let detail = try await workspace.detail(session)
            return .success(PhoneTeamReturn.reply(detail["messages"].array, requestId: requestId))
        } catch {
            return .failure(PhoneMemberReplyFailure(words: (error as? NativeFailure) == .expired ? "查看已过期，重新打开后再看" : "没能读取它的回复"))
        }
    }
}

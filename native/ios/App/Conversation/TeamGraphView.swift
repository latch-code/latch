import LatchNativeCore
import SwiftUI

/**
 * A team in its lead's conversation, the web's `TeamGraph` as it draws where the card is narrow: this session as a node,
 * a rail down from it that bends into a two-line pill per member, and last into the node where the results are. A pill
 * opens its member's session; 已交回 goes to the message that brought the results back. The phone has no write path
 * for the team yet, so 停止, 再派一轮 and the switch that lets the lead's agent send work stay on the desktop: the
 * switch's state is said, not offered.
 */
struct TeamGraphView: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.revealTurn) private var reveal
    let card: PhoneTeamGraph.Card
    let leadName: String
    let leadMark: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            head
            VStack(alignment: .leading, spacing: 0) {
                lead.padding(.bottom, TeamRail.gap)
                    .background { TeamRail.Stem(gap: TeamRail.gap).stroke(TeamRail.color(.idle), style: TeamRail.stroke(.idle)) }
                ForEach(card.members) { member in
                    row(member).padding(.leading, TeamRail.width).padding(.bottom, TeamRail.gap)
                        .background { TeamRail.Branch(wire: member.wire, gap: TeamRail.gap, last: false) }
                }
                end.padding(.leading, TeamRail.width)
                    .background { TeamRail.Branch(wire: card.endWire, gap: 0, last: true) }
            }
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(PhoneTheme.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("团队分工，\(card.members.count) 个成员")
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(PhoneConversation.visible(card.title)).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink2).lineLimit(1)
                Text(card.count).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).monospacedDigit().fixedSize()
                if let round = card.roundWords {
                    // The desktop says who sent the round on hover; a touch screen has none, so it is written out.
                    Text([round, card.byWords].compactMap { $0 }.joined(separator: " · "))
                        .font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).monospacedDigit().lineLimit(1).fixedSize()
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(PhoneTheme.bubble, in: RoundedRectangle(cornerRadius: 4))
                }
                Spacer(minLength: 0)
            }
            if card.dispatch {
                Text("已让它自己派活").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(1)
            }
        }
    }

    private var lead: some View {
        HStack(spacing: 6) {
            EngineTile(mark: leadMark, size: 16)
            Text(PhoneConversation.visible(leadName)).font(.system(size: 14, weight: .medium)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
        }
        .padding(.horizontal, 10).frame(minHeight: TeamRail.node)
        .background(PhoneTheme.raised, in: Capsule())
        .overlay(Capsule().strokeBorder(PhoneTheme.line))
    }

    @ViewBuilder private func row(_ member: PhoneTeamGraph.Member) -> some View {
        let pill = MemberPill(member: member)
        if let session = member.sessionId {
            Button { Task { await model.openSession(session) } } label: { pill }
                .buttonStyle(.plain).accessibilityHint("打开会话")
        } else {
            pill
        }
    }

    @ViewBuilder private var end: some View {
        let word = HStack(spacing: 6) {
            switch card.end {
            case .members: ProgressView().controlSize(.mini).tint(PhoneTheme.accent)
            case .returned: Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
            default: EmptyView()
            }
            Text(card.endWords).foregroundStyle(endTone)
            if let count = card.endCount { Text(count).foregroundStyle(PhoneTheme.muted).monospacedDigit() }
            if let kept = card.kept { Text("· " + kept).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
        }
        .font(.system(size: 13)).foregroundStyle(endTone)
        .padding(.horizontal, 10).frame(minHeight: TeamRail.node)
        .background(card.end == .returned ? PhoneTheme.accent.opacity(0.08) : Color.clear, in: Capsule())
        .background(PhoneTheme.raised, in: Capsule())
        .overlay(Capsule().strokeBorder(endBorder))
        // Room for a finger without moving the node off its wire.
        .padding(.vertical, 6)
        if card.end == .returned, let message = card.returnedMessageId, let reveal {
            Button { reveal.go(message) } label: { word.contentShape(Rectangle()) }
                .buttonStyle(.plain).accessibilityHint("回到交回的结果")
        } else {
            word
        }
    }

    private var endTone: Color {
        switch card.end {
        case .members: PhoneTheme.accent
        case .you: PhoneTheme.amber
        case .returned: PhoneTheme.ink2
        default: PhoneTheme.muted
        }
    }
    private var endBorder: Color {
        switch card.end {
        case .returned: PhoneTheme.accent.opacity(0.35)
        case .you: PhoneTheme.amberIcon.opacity(0.45)
        default: PhoneTheme.line
        }
    }
}

/** A member's two-line pill: its Harness, name and state, then why it did not start or the first line it said. */
private struct MemberPill: View {
    @EnvironmentObject private var model: PhoneModel
    let member: PhoneTeamGraph.Member
    private var unstarted: Bool { member.state == "unstarted" }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 8) {
                EngineTile(mark: model.engineMark(member.harnessId), size: 16)
                Text(PhoneConversation.visible(member.name)).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                Spacer(minLength: 6)
                HStack(spacing: 4) {
                    MemberStateWord(state: member.state)
                    if member.state == "running", let started = PhoneTime.parse(member.startedAt.map(NativeJSON.string) ?? .null) {
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            Text(PhoneTime.runClock(seconds: model.hostNow().timeIntervalSince(started)))
                                .font(.system(size: 13)).foregroundStyle(PhoneTheme.accent).monospacedDigit()
                        }
                    }
                }
            }
            if let line = member.line {
                Text(PhoneConversation.visible(line)).font(.system(size: 13))
                    .foregroundStyle(member.refused ? PhoneTheme.red.opacity(0.85) : PhoneTheme.muted).lineLimit(1)
                    .padding(.leading, 24)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: TeamRail.row, alignment: .leading)
        .background(unstarted ? Color.clear : PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(border, style: StrokeStyle(lineWidth: 1, dash: unstarted ? [4, 3] : [])))
        .contentShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([member.name, member.title, model.engineName(member.harnessId), PhoneTeamReturn.words(member.state), member.line]
            .compactMap { $0.map(PhoneConversation.visible) }.filter { !$0.isEmpty }.joined(separator: "，"))
    }
    private var border: Color {
        switch member.state {
        case "waiting": PhoneTheme.amberIcon.opacity(0.5)
        case "failed": PhoneTheme.red.opacity(0.4)
        case "unstarted": PhoneTheme.lineStrong
        default: PhoneTheme.line
        }
    }
}

/**
 * The rail, drawn a row at a time so a row may grow with its text: the spine runs under the middle of this session's
 * mark, and each row's wire bends off it into the row at its middle, coloured by what went in to that member.
 */
private enum TeamRail {
    static let width: CGFloat = 32
    /** Under the middle of the lead's mark: the node's inset (10) and half its 16pt mark. */
    static let spine: CGFloat = 18
    static let gap: CGFloat = 8
    static let row: CGFloat = 52
    static let node: CGFloat = 32

    static func color(_ wire: PhoneTeamGraph.Wire) -> Color {
        switch wire {
        case .flow: PhoneTheme.accent.opacity(0.4)
        case .done: PhoneTheme.accent.opacity(0.7)
        case .waiting: PhoneTheme.amberIcon.opacity(0.75)
        case .quiet: PhoneTheme.muted.opacity(0.6)
        case .none, .idle: PhoneTheme.lineStrong
        }
    }
    static func stroke(_ wire: PhoneTeamGraph.Wire) -> StrokeStyle {
        StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: wire == .none ? [1, 4] : [])
    }

    /** From under the lead's node down to the first row. */
    struct Stem: Shape {
        let gap: CGFloat
        func path(in rect: CGRect) -> Path {
            Path { path in
                path.move(to: CGPoint(x: spine, y: rect.maxY - gap))
                path.addLine(to: CGPoint(x: spine, y: rect.maxY))
            }
        }
    }

    /** A row's wire off the spine, and the spine on past it to the next row unless it is the last. */
    struct Branch: View {
        let wire: PhoneTeamGraph.Wire
        let gap: CGFloat
        let last: Bool
        var body: some View {
            ZStack {
                if !last { Continue(gap: gap).stroke(color(.idle), style: stroke(.idle)) }
                Elbow(gap: gap).stroke(color(wire), style: stroke(wire))
            }
        }
    }
    private struct Elbow: Shape {
        let gap: CGFloat
        func path(in rect: CGRect) -> Path {
            let middle = (rect.height - gap) / 2
            return Path { path in
                path.move(to: CGPoint(x: spine, y: 0))
                path.addLine(to: CGPoint(x: spine, y: middle - 8))
                path.addQuadCurve(to: CGPoint(x: spine + 8, y: middle), control: CGPoint(x: spine, y: middle))
                path.addLine(to: CGPoint(x: width, y: middle))
            }
        }
    }
    private struct Continue: Shape {
        let gap: CGFloat
        func path(in rect: CGRect) -> Path {
            Path { path in
                path.move(to: CGPoint(x: spine, y: (rect.height - gap) / 2 - 8))
                path.addLine(to: CGPoint(x: spine, y: rect.maxY))
            }
        }
    }
}

/** Brings a turn of the conversation into view. One conversation's is always equal, so redrawing it moves nothing. */
struct RevealTurn: Equatable {
    let session: String
    let go: @MainActor (String) -> Void
    static func == (left: RevealTurn, right: RevealTurn) -> Bool { left.session == right.session }
}

extension EnvironmentValues {
    /** Set where the conversation can scroll to a turn. */
    @Entry var revealTurn: RevealTurn? = nil
}

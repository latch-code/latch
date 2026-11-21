import LatchNativeCore
import SwiftUI

struct WorkEvidenceView: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let sessionId: String
    let stamp: PhoneWorkReadStamp

    var body: some View {
        WorkEvidencePage(title: "交付证据", itemId: itemId, stamp: stamp,
            destination: .evidence(session: sessionId), read: read) { evidence in
            WorkSectionTitle(title: model.summary(of: sessionId)["title"].string.map(PhoneConversation.visible) ?? "关联会话")
            if evidence.notRepository {
                Text("这个会话没有 Git 仓库").font(.subheadline).foregroundStyle(PhoneTheme.muted)
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    Text("本地 HEAD").font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.muted)
                    if let head = evidence.head {
                        WorkSha(value: head, other: evidence.pr?.sha)
                        WorkRouteLink(title: "查看提交差异", icon: "arrow.triangle.branch", destination: .commit(session: sessionId, sha: head), subrow: true)
                            .disabled(!model.connected)
                        if let at = evidence.observedAt {
                            Text("读取于 " + PhoneTime.message(at)).font(.caption).foregroundStyle(PhoneTheme.muted)
                        }
                    } else {
                        Text(evidence.stateFailed ? "读不到仓库状态" : "没有提交").font(.subheadline).foregroundStyle(PhoneTheme.muted)
                    }
                }.workEvidenceCard()
                VStack(alignment: .leading, spacing: 8) {
                    if let pr = evidence.pr {
                        WorkRouteLink(title: "PR #\(pr.number) · \(pr.title)", icon: "arrow.triangle.pull", destination: .pullRequest(session: sessionId, number: pr.number))
                            .disabled(!model.connected)
                        WorkPRVersion(pr: pr, head: evidence.head)
                        if let at = evidence.prObservedAt {
                            Text("读取于 " + PhoneTime.message(at)).font(.caption).foregroundStyle(PhoneTheme.muted)
                        }
                        if pr.sha != nil { WorkCheckSummary(checks: pr.checks) }
                    } else {
                        Text(evidence.prFailed ? "读不到 PR" : "尚未绑定 PR").font(.subheadline).foregroundStyle(PhoneTheme.muted)
                    }
                }.workEvidenceCard()
            }
        }
    }
    private func read(_ destination: PhoneWorkDestination) async throws -> PhoneWorkEvidence {
        let raw = try await model.readWork(.delivery([sessionId]), itemId: itemId, stamp: stamp, destination: destination)
        guard let entry = try PhoneWorkEvidence.read(raw, sessions: [sessionId]).first else { throw NativeFailure.invalidRecord }
        return entry
    }
}

struct WorkCommitView: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let sessionId: String
    let sha: String
    let stamp: PhoneWorkReadStamp

    var body: some View {
        WorkEvidencePage(title: "提交差异", itemId: itemId, stamp: stamp,
            destination: .commit(session: sessionId, sha: sha), read: read) { commit in
            WorkSha(value: commit.sha)
            if commit.files.isEmpty { Text("这个提交没有文件差异").font(.subheadline).foregroundStyle(PhoneTheme.muted) }
            ForEach(commit.files) { file in
                NavigationLink(value: PhoneWorkDestination.commitFile(session: sessionId, sha: commit.sha, path: file.path)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(PhoneConversation.visible(file.path)).font(.subheadline.monospaced()).foregroundStyle(PhoneTheme.ink)
                        HStack {
                            if let add = file.add { Text("+\(add)").foregroundStyle(PhoneTheme.green) }
                            if let del = file.del { Text("−\(del)").foregroundStyle(PhoneTheme.red) }
                            if file.binary { Text("二进制文件").foregroundStyle(PhoneTheme.muted) }
                        }.font(.caption.monospacedDigit())
                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(!model.connected)
            }
            if commit.more > 0 {
                WorkReadNotice(title: "还有 \(commit.more) 个文件 · 到 Mac 上查看")
            }
        }
    }
    private func read(_ destination: PhoneWorkDestination) async throws -> PhoneWorkCommit {
        let raw = try await model.readWork(.commit(sessionId, sha: sha, file: nil), itemId: itemId, stamp: stamp, destination: destination)
        return try PhoneWorkCommit(raw, sha: sha)
    }
}

struct WorkCommitFileView: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let sessionId: String
    let sha: String
    let path: String
    let stamp: PhoneWorkReadStamp

    var body: some View {
        WorkEvidencePage(title: "文件差异", itemId: itemId, stamp: stamp,
            destination: .commitFile(session: sessionId, sha: sha, path: path), read: read) { file in
            WorkSha(value: sha)
            Text(PhoneConversation.visible(path)).font(.headline.monospaced())
            if let hidden = file.hidden { Text(hidden).font(.subheadline).foregroundStyle(PhoneTheme.muted) }
            else if file.lines.isEmpty { Text("没有文本差异").font(.subheadline).foregroundStyle(PhoneTheme.muted) }
            else { DiffTextView(lines: file.lines, selection: nil, noted: [], onTap: nil) }
        }
    }
    private func read(_ destination: PhoneWorkDestination) async throws -> (lines: [PhoneReviewLine], hidden: String?) {
        let raw = try await model.readWork(.commit(sessionId, sha: sha, file: path), itemId: itemId, stamp: stamp, destination: destination)
        return try PhoneWorkCommit.file(raw, sha: sha, path: path)
    }
}

private struct WorkPRRead {
    let pr: PhoneWorkPullRequest
    let head: String?
    let comments: [NativeJSON]
    let capped: Bool
}

struct WorkPullRequestView: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let sessionId: String
    let number: UInt64
    let stamp: PhoneWorkReadStamp

    var body: some View {
        WorkEvidencePage(title: "PR #\(number)", itemId: itemId, stamp: stamp,
            destination: .pullRequest(session: sessionId, number: number), read: read) { value in
            let pr = value.pr
            WorkSectionTitle(title: PhoneConversation.visible(pr.title))
            HStack(spacing: 9) {
                Text(pr.draft && pr.state == .open ? "草稿" : pr.state.label)
                if let review = pr.review { Text(review) }
            }.font(.subheadline).foregroundStyle(PhoneTheme.muted)
            WorkPRVersion(pr: pr, head: value.head)
            if let url = pr.url, model.connected {
                Link(destination: url) { Label("打开 PR", systemImage: "arrow.up.right.square").frame(minHeight: 44) }.font(.subheadline)
            }

            WorkSectionTitle(title: "检查")
            if let sha = pr.sha {
                if pr.checks.isEmpty { Text("没有检查记录").font(.subheadline).foregroundStyle(PhoneTheme.muted) }
                ForEach(Array(pr.checks.enumerated()), id: \.offset) { _, check in
                    checkRow(check, sha: sha)
                }
            } else { WorkReadNotice(title: "检查版本尚未确认") }

            if !value.comments.isEmpty || value.capped {
                WorkSectionTitle(title: "PR 审阅与评论")
                if value.capped {
                    Label("已省略部分讨论", systemImage: "ellipsis.text.bubble").font(.subheadline).foregroundStyle(PhoneTheme.muted)
                }
                ForEach(Array(value.comments.enumerated()), id: \.offset) { _, comment in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(PhoneConversation.visible(comment["author"].string ?? "审阅者"))
                            .font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.ink2)
                        if let path = comment["path"].string {
                            Text(PhoneConversation.visible(path) + (comment["line"].integer.map { ":\($0)" } ?? ""))
                                .font(.caption.monospaced()).foregroundStyle(PhoneTheme.muted)
                        }
                        if let body = comment["body"].string { MarkdownView(text: PhoneConversation.visible(body)) }
                    }.workEvidenceCard()
                }
            }
        }
    }

    private func checkRow(_ check: PhoneWorkCheck, sha: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(PhoneConversation.visible(check.name)).font(.subheadline.weight(.medium))
            if let workflow = check.workflow { Text(PhoneConversation.visible(workflow)).font(.caption).foregroundStyle(PhoneTheme.muted) }
            Label(check.state.label, systemImage: check.state == .pass ? "checkmark" : check.state == .fail ? "xmark.circle" : "circle")
                .font(.caption).foregroundStyle(check.state == .pass ? PhoneTheme.green : check.state == .fail ? PhoneTheme.red : PhoneTheme.muted)
            if let job = check.job {
                WorkRouteLink(title: "失败日志", icon: "doc.text", destination: .checkLog(session: sessionId, number: number, sha: sha, job: job), subrow: true)
                    .disabled(!model.connected)
            }
        }.workEvidenceCard()
    }

    private func read(_ destination: PhoneWorkDestination) async throws -> WorkPRRead {
        let local = try await model.readWork(.delivery([sessionId]), itemId: itemId, stamp: stamp, destination: destination)
        let head = try PhoneWorkEvidence.read(local, sessions: [sessionId]).first?.head
        let raw = try await model.readWork(.pullRequest(sessionId), itemId: itemId, stamp: stamp, destination: destination)
        guard let pr = PhoneWorkPullRequest(raw), pr.number == number else { throw PhoneWorkReadFailure.versionChanged }
        let discussion = PhoneWorkPRDiscussion(raw)
        return WorkPRRead(pr: pr, head: head, comments: discussion.comments, capped: discussion.capped)
    }
}

private struct WorkLogRead {
    let name: String
    let text: String
    let capped: Bool
}

struct WorkCheckLogView: View {
    @EnvironmentObject private var model: PhoneModel
    let itemId: String
    let sessionId: String
    let number: UInt64
    let sha: String
    let job: String
    let stamp: PhoneWorkReadStamp

    var body: some View {
        WorkEvidencePage(title: "失败日志", itemId: itemId, stamp: stamp,
            destination: .checkLog(session: sessionId, number: number, sha: sha, job: job), read: read) { value in
            WorkSectionTitle(title: PhoneConversation.visible(value.name))
            WorkSha(value: sha)
            if value.capped { WorkReadNotice(title: "仅保留末尾失败日志") }
            ConversationText(text: PhoneConversation.visible(value.text), monospaced: true, size: 14)
        }
    }
    private func read(_ destination: PhoneWorkDestination) async throws -> WorkLogRead {
        let before = try await checkedJob(destination)
        let raw = try await model.readWork(.checkLog(sessionId, job: job), itemId: itemId, stamp: stamp, destination: destination)
        let after = try await checkedJob(destination)
        guard before == after, let name = raw["name"].string, name.utf8.elementsEqual(before.name.utf8),
              let text = raw["text"].string, text.utf8.count <= 32 * 1024 else { throw PhoneWorkReadFailure.checkChanged }
        return WorkLogRead(name: name, text: text, capped: raw["truncated"] == .bool(true))
    }
    private func checkedJob(_ destination: PhoneWorkDestination) async throws -> PhoneWorkCheck {
        let value = try await model.readWork(.pullRequest(sessionId), itemId: itemId, stamp: stamp, destination: destination)
        guard let pr = PhoneWorkPullRequest(value), pr.number == number, let check = pr.failedCheck(job: job, sha: sha) else {
            throw PhoneWorkReadFailure.checkChanged
        }
        return check
    }
}

/** Repository reads replace only the result for this window. On a failed re-read no old check is labeled current. */
private struct WorkEvidencePage<Value, Content: View>: View {
    @EnvironmentObject private var model: PhoneModel
    let title: String
    let itemId: String
    let stamp: PhoneWorkReadStamp
    let destination: PhoneWorkDestination
    let read: (PhoneWorkDestination) async throws -> Value
    @ViewBuilder let content: (Value) -> Content
    @State private var value: Value?
    @State private var failure: String?
    @State private var request = UUID()

    private var readable: Bool {
        stamp == model.workStamp(itemId) && model.workDestinationAllowed(destination, itemId: itemId)
    }

    var body: some View {
        WorkPage(title: title) {
            if !readable {
                if model.connected { WorkReadNotice(title: "交付证据暂不可用") }
            } else if !PhoneWorkItems.canReadFiles(model.snapshot) {
                WorkReadNotice(title: "这台设备没有项目文件权限")
            } else if let value {
                content(value)
            } else if let failure {
                WorkReadNotice(title: failure, retry: load)
            } else if model.connected {
                WorkLoading(label: "正在读取证据…")
            }
        }
        .task(id: stamp) { await load() }
        .onChange(of: readable) { _, readable in
            if !readable { value = nil; failure = nil }
        }
        .refreshable { await load() }
    }

    private func load() async {
        guard readable, PhoneWorkItems.canReadFiles(model.snapshot), model.workPath.last == destination else { return }
        let mine = UUID(), navigation = model.workPathGeneration
        request = mine
        value = nil; failure = nil
        do {
            let read = try await read(destination)
            guard mine == request, readable, model.workPathGeneration == navigation, !Task.isCancelled else { return }
            model.publishWork(stamp, itemId: itemId) { value = read }
        } catch {
            guard mine == request, readable, model.workPathGeneration == navigation, !Task.isCancelled, !(error is CancellationError) else { return }
            model.publishWork(stamp, itemId: itemId) { failure = workReadWords(error, fallback: "读不到交付证据") }
        }
    }
}

private struct WorkSha: View {
    let value: String
    var other: String? = nil
    @State private var expanded = false

    private var abbreviation: String {
        // When two versions share the usual prefix, include the first character that distinguishes them.
        let shared = other.flatMap { $0 == value ? nil : zip(value, $0).prefix(while: { $0.0 == $0.1 }).count } ?? 0
        return String(value.prefix(max(12, shared + 1)))
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                ConversationText(text: value, monospaced: true, size: 14)
                Button("复制完整提交号", systemImage: "doc.on.doc") { LocalClipboard.copy(value) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(abbreviation).font(.subheadline.monospaced()).foregroundStyle(PhoneTheme.ink)
                .accessibilityLabel("提交 " + value)
        }
        .tint(PhoneTheme.ink2)
    }
}

private struct WorkPRVersion: View {
    let pr: PhoneWorkPullRequest
    let head: String?

    var body: some View {
        if let sha = pr.sha {
            Text("PR 检查提交").font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.muted)
            WorkSha(value: sha, other: head)
            if let head, head != sha {
                Label("检查对应另一提交", systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(PhoneTheme.amber)
                Text("本地 HEAD").font(.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.muted)
                WorkSha(value: head, other: sha)
            } else if head == nil {
                Text("本地 HEAD 尚未确认").font(.subheadline).foregroundStyle(PhoneTheme.muted)
            }
        } else { Text("检查版本尚未确认").font(.subheadline).foregroundStyle(PhoneTheme.muted) }
    }
}

private struct WorkCheckSummary: View {
    let checks: [PhoneWorkCheck]
    var body: some View {
        let states: [PhoneWorkCheck.State] = [.fail, .pending, .pass, .skipped]
        let groups: [(PhoneWorkCheck.State, Int)] = states.compactMap { state in
            let count = checks.filter { $0.state == state }.count
            return count > 0 ? (state, count) : nil
        }
        if groups.isEmpty { Text("没有检查记录").font(.subheadline).foregroundStyle(PhoneTheme.muted) }
        else {
            Text(groups.map { $0.0.label + " \($0.1)" }.joined(separator: " · ")).font(.subheadline).foregroundStyle(PhoneTheme.ink2)
        }
    }
}

private extension View {
    func workEvidenceCard() -> some View {
        padding(12).frame(maxWidth: .infinity, alignment: .leading).background(PhoneTheme.raised, in: RoundedRectangle(cornerRadius: 12))
    }
}

import LatchNativeCore
import SwiftUI

/**
 * 提交, pushed over the review: the four groups, each row's box staging or unstaging it alone (its own request, the row
 * turning until the Host reads it back), the message, 跳过钩子, and the one blue button 暂存全部 → 提交 N 个文件 → 推送.
 */
struct DeliveryView: View {
    @EnvironmentObject private var model: PhoneModel
    let sessionId: String
    /** A row's name opens its diff in 未提交. */
    var openFile: ((String) -> Void)? = nil
    @State private var state: PhoneGitState?
    @State private var denied = false
    @State private var readFailure: String?
    @State private var queue: [(paths: [String], unstage: Bool)] = []
    @State private var draining = false
    @State private var writing: String?
    @State private var refusal: (kind: String, value: NativeHostRefusal)?
    @State private var outcome: String?
    @State private var committed = false
    @State private var message = ""
    @State private var skipHooks = false
    @State private var showHint = false
    @State private var composed = false
    @State private var checked: String?
    /** A retry's refusal that left the result unknown. */
    @State private var unsettled: NativeHostRefusal?
    private var summary: NativeJSON { model.summary(of: sessionId) }
    private var turnRunning: Bool { ["running", "waiting-approval"].contains(summary["status"].string ?? "") }
    private var canWrite: Bool { model.canRun && summary["personal"] == .null }
    private var unknown: NativePendingWrite? {
        model.pending.first { $0.path == "/link/api/tasks/\(sessionId)/git/commit" || $0.path == "/link/api/tasks/\(sessionId)/git/push" }
    }
    /** Rows turn only while their write is on its way; one without an answer is offered again below, not spun. */
    private var rowPending: [String: Bool] {
        var result: [String: Bool] = [:]
        for item in queue { for path in item.paths { result[path] = !item.unstage } }
        return result
    }
    /** A stage or unstage of this session whose answer never came. */
    private var unknownStage: NativePendingWrite? { model.pending.first { PhoneDelivery.isStage($0) && $0.path.hasPrefix("/link/api/tasks/\(sessionId)/git/") } }
    /** Something is on its way now: the Host's own write, or this page's. An unknown answer is not under way. */
    private var inFlight: Bool { state?.running != nil || writing != nil || !queue.isEmpty }
    private var busy: Bool { inFlight || model.busy }
    private var blocked: Bool { !model.connected || !canWrite || state?.operation != nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                notesLines
                if denied { lockedBody }
                else if let state { groups(state) }
                else if let readFailure {
                    VStack(spacing: 8) {
                        Text(readFailure).font(PhoneTheme.body).foregroundStyle(PhoneTheme.ink2)
                        Button("重试") { Task { await load() } }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(PhoneTheme.ink)
                    }.frame(maxWidth: .infinity).padding(.top, 48)
                } else { HStack(spacing: 8) { ProgressView().controlSize(.small); Text("正在读取…").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }.padding(.top, 24) }
            }.padding(16)
        }
        .background(PhoneTheme.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(committed)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("提交").font(.system(size: 15, weight: .semibold))
                    Text(PhoneConversation.visible(summary["title"].string ?? "未命名会话")).font(.system(size: 11)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                }
            }
            if committed {
                // After a commit or a push, back goes to the list.
                ToolbarItem(placement: .topBarLeading) { Button("返回会话列表", systemImage: "chevron.left") { model.reviewTarget = nil }.labelStyle(.iconOnly) }
            }
            if let running = state?.running {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 4) { ProgressView().controlSize(.mini).tint(PhoneTheme.accent); Text(PhoneDelivery.runningLabel(kind: running.kind, hook: running.hook)).font(PhoneTheme.caption) }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { foot }
        .task {
            #if LATCH_SCREENS
            if model.staged, let staged = ScreensStage.deliveryRefusal { refusal = staged; message = "fix(ios): only send a model the service owns" }
            #endif
            await load()
        }
        .task(id: inFlight) {
            // The hook Git runs changes without an event: read again while a write is under way, and only then.
            while inFlight && !Task.isCancelled { try? await Task.sleep(for: .milliseconds(1500)); if !Task.isCancelled { await load() } }
        }
        .onChange(of: turnRunning) { _, now in if !now { Task { await load() } } }
    }

    private func load() async {
        do {
            let value = try await model.reviewRead(try PhoneDelivery.statePath(sessionId))
            state = PhoneGitState(value); denied = false; readFailure = nil
        } catch {
            if (error as? NativeFailure) == .forbidden { denied = true }
            else if state == nil { readFailure = "读不到仓库" }
        }
    }

    // MARK: lines above the groups

    @ViewBuilder private var notesLines: some View {
        if !model.connected { line("\(model.selectedHost?.name ?? "Mac") 不在线 · 恢复后再交付", tone: .warn) }
        if summary["personal"] != .null { line("这个会话只读", tone: .neutral) }
        if let operation = state?.operation { line(PhoneDelivery.operationNote(operation), tone: .warn) }
        if turnRunning && state?.operation == nil && canWrite, let copy = PhoneDelivery.copy("git-turn-running") { line(copy.label, tone: .neutral, detail: copy.detail) }
        if let unknown {
            let what = unknown.path.hasSuffix("/commit") ? "提交" : "推送"
            let fresh = what == "提交" ? "新的提交只提交那时暂存的文件，第一次已经提交的不会再提交一次。" : "新的推送照常推送当前分支，从不强制。"
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(what + "结果未知", systemImage: "questionmark.circle").foregroundStyle(PhoneTheme.amber)
                InfoHint(text: "没有收到答复，这台电脑可能已经\(what)。重试沿用同一请求，电脑会先核对结果，不会\(what)两次。放弃这次结果只在这个页面上放下它，之后可以发起新的请求；电脑上的记录仍是结果未知。" + fresh)
                Spacer()
                Button("放弃这次结果") { Task { await abandon(unknown) } }.disabled(writing != nil || model.busy)
                Button(writing != nil ? "核对中…" : "重试同一请求") { Task { await run(unknown) } }.buttonStyle(.bordered).buttonBorderShape(.capsule)
                    .disabled(!model.connected || writing != nil || model.busy)
            }.font(PhoneTheme.caption)
            // The retry's refusal, under the row: it did not settle the first attempt, so the row stays.
            if let unsettled {
                let copy = PhoneDelivery.copy(unsettled.code, operation: state?.operation)
                line(copy?.label ?? (unsettled.message.isEmpty ? "没有完成" : unsettled.message), tone: copy?.tone ?? .failed, detail: copy?.detail)
            }
        }
        if let stage = unknownStage {
            HStack(alignment: .firstTextBaseline) {
                Label(PhoneDelivery.pendingWords(stage) ?? "暂存结果待确认", systemImage: "questionmark.circle").foregroundStyle(PhoneTheme.amber)
                Spacer()
                Button("核对并放下") { Task { checked = await model.checkAndDrop(stage) ?? "没能核对，稍后再试"; await load() } }.disabled(model.busy)
                Button("重试这次提交") { Task { await retryStage(stage) } }.buttonStyle(.bordered).buttonBorderShape(.capsule).disabled(!model.connected || model.busy)
            }.font(PhoneTheme.caption)
        }
        if let checked { Label(checked, systemImage: "info.circle").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
        if let refusal {
            if PhoneDelivery.isHookCard(refusal.value) { hookCard(refusal.value, push: refusal.kind == "push") }
            else if !(refusal.value.code == "git-turn-running" && turnRunning) {
                if let copy = PhoneDelivery.copy(refusal.value.code, operation: state?.operation) {
                    line(copy.label + (refusal.value.code == "git-push-failed" ? refusal.value.details["exitCode"].integer.map { " · 退出码 \($0)" } ?? "" : ""), tone: copy.tone, detail: copy.detail)
                    if let tail = refusal.value.details["tail"].string, refusal.value.code == "git-commit-failed" { output(tail, label: "Git 输出") }
                    if refusal.value.code == "git-push-remote-rejected" { output(refusal.value.details["remoteLines"].array.compactMap(\.string).joined(separator: "\n"), label: "远端输出") }
                } else { line(refusal.value.message.isEmpty ? "没有完成" : refusal.value.message, tone: .failed) }
            }
        }
        if let outcome { Label(outcome, systemImage: "checkmark").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2) }
    }
    private func line(_ text: String, tone: PhoneDeliveryCopy.Tone, detail: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: tone == .failed ? "exclamationmark.circle" : tone == .warn ? "exclamationmark.triangle" : "info.circle")
            Text(PhoneConversation.visible(text))
            if let detail { InfoHint(text: detail) }
        }.font(PhoneTheme.caption).foregroundStyle(tone == .failed ? PhoneTheme.red : tone == .warn ? PhoneTheme.amber : PhoneTheme.muted)
    }
    private func output(_ text: String, label: String) -> some View {
        ScrollView { Text(PhoneConversation.visible(text)).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(PhoneTheme.ink2).frame(maxWidth: .infinity, alignment: .leading).padding(8) }
            .frame(maxHeight: 180).background(PhoneTheme.sunken, in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel(label)
    }
    /** A hook that refused: its name, exit code and the end of its output, which can go into the session's draft. */
    private func hookCard(_ value: NativeHostRefusal, push: Bool) -> some View {
        let hook = value.details["hook"].string, exit = value.details["exitCode"].integer, tail = value.details["tail"].string
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.circle").foregroundStyle(PhoneTheme.red)
                Text(push ? "推送前的钩子没通过" : "提交钩子没通过").font(.system(size: 14, weight: .semibold))
                Spacer()
                Text((hook ?? (push ? "pre-push" : "pre-commit")) + (exit.map { " · 退出码 \($0)" } ?? "")).font(.system(size: 12, design: .monospaced)).foregroundStyle(PhoneTheme.muted)
            }
            if let tail, !tail.isEmpty { output(tail, label: "钩子输出") }
            HStack {
                Text(push ? "没有推送" : "没有生成提交，暂存保持不变").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                Spacer()
                Button(composed ? "已加入" : "加入对话", systemImage: "text.bubble") {
                    model.addToDraft(PhoneDelivery.hookExcerpt(hook: hook, exitCode: exit, tail: tail, push: push), session: sessionId); composed = true
                }.buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(PhoneTheme.ink).disabled(composed)
            }
        }.padding(12).background(PhoneTheme.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(PhoneTheme.red.opacity(0.35)))
    }

    // MARK: groups

    private func groups(_ state: PhoneGitState) -> some View {
        let fileWrites = !blocked && !turnRunning && state.running == nil
        let pending = rowPending
        return VStack(alignment: .leading, spacing: 14) {
            if state.staged.isEmpty && state.changedCount == 0 { Label("没有未提交的改动", systemImage: "checkmark").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
            else {
                ForEach(PhoneDeliveryGroup.allCases, id: \.self) { group in
                    let rows = state.rows(group)
                    if !rows.isEmpty || group == .staged {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack {
                                Text(group.title).font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted)
                                Spacer(); Text("\(rows.count)").font(.system(size: 12)).foregroundStyle(PhoneTheme.faint)
                            }.padding(.vertical, 6)
                            if rows.isEmpty { Text("还没有暂存的文件").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.faint).padding(.vertical, 6) }
                            ForEach(rows) { row in
                                let wanted = pending[row.path]
                                HStack(spacing: 10) {
                                    Button {
                                        guard fileWrites, wanted == nil else { return }
                                        enqueue([row.path], unstage: row.staged)
                                    } label: {
                                        Image(systemName: (wanted ?? row.staged) ? "checkmark.square.fill" : "square").font(.system(size: 20))
                                            .foregroundStyle((wanted ?? row.staged) ? PhoneTheme.accent : PhoneTheme.muted).frame(width: 44, height: 44)
                                    }.buttonStyle(.plain).disabled(!fileWrites || wanted != nil)
                                        .accessibilityLabel((row.staged ? "取消暂存 " : "暂存 ") + PhoneConversation.visible(row.path))
                                    Button { openFile?(row.path) } label: {
                                        Text(PhoneConversation.visible(row.path)).font(.system(size: 13, design: .monospaced)).foregroundStyle(PhoneTheme.ink).lineLimit(1).truncationMode(.head)
                                    }.buttonStyle(.plain)
                                    Spacer(minLength: 4)
                                    if wanted != nil { ProgressView().controlSize(.mini) } else { Text(row.word).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted) }
                                }
                            }
                        }
                    }
                }
                if state.more > 0 { Text("还有 \(state.more) 个").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                if case .stage? = PhoneDelivery.primary(state, justCommitted: committed) {} else if state.changedCount > 0 {
                    Button("全部暂存") { enqueue(state.stageAllPaths, unstage: false) }.font(PhoneTheme.caption).disabled(!fileWrites || busy)
                }
            }
            if !state.staged.isEmpty || unknown?.path.hasSuffix("/commit") == true { messageBox(state) }
            pushSection(state)
        }
    }
    private func messageBox(_ state: PhoneGitState?) -> some View {
        let frozen = writing == "commit" || unknown?.path.hasSuffix("/commit") == true
        return VStack(alignment: .leading, spacing: 8) {
            Text("提交信息").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted)
            TextField("提交信息", text: $message, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder).font(.system(size: 14, design: .monospaced))
                .disabled(frozen || !canWrite).autocorrectionDisabled().textInputAutocapitalization(.never)
            HStack(spacing: 6) {
                Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
                Text(skipHooks ? "这次不运行提交钩子" : "运行仓库钩子").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2)
                InfoHint(text: PhoneDelivery.hooksDetail(state))
                Spacer()
                Toggle("跳过钩子", isOn: $skipHooks).font(PhoneTheme.caption).fixedSize().tint(PhoneTheme.accent).disabled(frozen || !canWrite)
            }
        }
    }
    @ViewBuilder private func pushSection(_ state: PhoneGitState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("推送").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.muted)
            if state.branch == nil, let copy = PhoneDelivery.copy("git-detached") { line(copy.label, tone: .neutral, detail: copy.detail) }
            else if state.head == nil, let copy = PhoneDelivery.copy("git-no-commit") { line(copy.label, tone: .neutral) }
            else if state.remote == nil, let copy = PhoneDelivery.copy("git-no-remote") { line(copy.label, tone: .neutral) }
            else if let remote = state.remote, let branch = state.branch {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.circle").font(.system(size: 13))
                    Text(PhoneConversation.visible(remote)).font(.system(size: 13, design: .monospaced)); Image(systemName: "chevron.right").font(.system(size: 10))
                    Text(PhoneConversation.visible(branch)).font(.system(size: 13, design: .monospaced)).lineLimit(1)
                    Spacer()
                    Text(state.aheadBehind)
                        .font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
                }.foregroundStyle(PhoneTheme.ink2)
                if state.upstreamOther, let copy = PhoneDelivery.copy("git-upstream-other-branch") { line(copy.label, tone: .neutral, detail: (copy.detail ?? "") + " 上游：" + (state.upstream ?? "")) }
            }
        }
    }
    /** Without the full data scope the files stay locked; a commit of what is staged and a push do not. */
    private var lockedBody: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(spacing: 8) {
                Image(systemName: "lock").foregroundStyle(PhoneTheme.muted)
                Text("这台设备看不到会话文件夹里的文件").font(PhoneTheme.body)
                Text("在 \(model.selectedHost?.name ?? "Mac") 上开启「可以看项目文件」").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
            }.frame(maxWidth: .infinity).padding(.vertical, 24)
            if canWrite { messageBox(nil) }
        }
    }

    // MARK: the foot and the writes

    @ViewBuilder private var foot: some View {
        if canWrite {
            HStack(spacing: 10) {
                if denied {
                    Button(writing == "push" ? "推送中…" : "推送") { Task { await push() } }.buttonStyle(.bordered).buttonBorderShape(.capsule)
                        .disabled(!model.connected || busy || unknown?.path.hasSuffix("/push") == true)
                    Spacer()
                    primaryButton(writing == "commit" ? "提交中…" : "提交已暂存的") { Task { await commit() } }
                        .disabled(!model.connected || busy || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || unknown != nil)
                } else if let state {
                    Text(PhoneDelivery.footNote(state) ?? "").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).lineLimit(2)
                    Spacer()
                    if let primary = PhoneDelivery.primary(state, justCommitted: committed), !(primary.label.hasPrefix("推送") && state.upstreamOther) {
                        let blockedNow: Bool = {
                            if blocked || busy || unknown != nil { return true }
                            if case .push = primary { return false }
                            if turnRunning { return true }
                            if case .commit = primary { return message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !state.conflicted.isEmpty }
                            return false
                        }()
                        primaryButton(running(primary) ?? primary.label) {
                            switch primary {
                            case let .stage(_, paths): enqueue(paths, unstage: false)
                            case .commit: Task { await commit() }
                            case .push: Task { await push() }
                            }
                        }.disabled(blockedNow)
                    }
                }
            }.padding(.horizontal, 16).padding(.vertical, 10).background(.bar)
        }
    }
    private func running(_ primary: PhoneDeliveryPrimary) -> String? {
        switch primary {
        case .stage: rowPending.isEmpty ? nil : "暂存中…"
        case .commit: writing == "commit" ? "提交中…" : nil
        case .push: writing == "push" ? "推送中…" : nil
        }
    }
    private func primaryButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(label).font(.system(size: 15, weight: .semibold)).padding(.horizontal, 18).frame(minHeight: 44) }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).tint(PhoneTheme.accent)
    }

    /** Stage and unstage go one at a time, in the order pressed: the Host takes one write per repository at a time. */
    private func enqueue(_ paths: [String], unstage: Bool) {
        guard !paths.isEmpty else { return }
        queue.append((paths, unstage))
        guard !draining else { return }
        draining = true
        Task {
            while let next = queue.first {
                if let request = try? PhoneDelivery.stage(sessionId: sessionId, paths: next.paths, unstage: next.unstage) {
                    let outcome = await model.write(request, timeout: PhoneDelivery.timeout(request), retryAnswered: PhoneDelivery.retryAnswered(request), refresh: false)
                    if case let .refused(value) = outcome { refusal = (next.unstage ? "unstage" : "stage", value) }
                }
                await load()
                queue.removeFirst()
            }
            draining = false
        }
    }
    /** 放弃这次结果: lets go of this device's unknown result so a new request can be made; the Host's record stays unknown. */
    private func abandon(_ request: NativePendingWrite) async {
        if request.path.hasSuffix("/commit") { skipHooks = false }
        await model.settle(request)
        unsettled = nil; refusal = nil
        await load()
    }
    private func retryStage(_ request: NativePendingWrite) async {
        checked = nil
        if case let .refused(value) = await model.write(request, timeout: PhoneDelivery.timeout(request), retryAnswered: PhoneDelivery.retryAnswered(request), refresh: false) {
            refusal = (request.path.hasSuffix("/unstage") ? "unstage" : "stage", value)
        }
        await load()
    }
    private func commit() async {
        guard let request = try? PhoneDelivery.commit(sessionId: sessionId, message: message, skipHooks: skipHooks) else { return }
        await run(request)
    }
    private func push() async {
        guard let request = try? PhoneDelivery.push(sessionId: sessionId) else { return }
        await run(request)
    }
    /** A commit or push, or the same request again after no answer: the Host answers a retry from its receipt. */
    private func run(_ request: NativePendingWrite) async {
        let kind = request.path.hasSuffix("/commit") ? "commit" : "push"
        writing = kind; refusal = nil; outcome = nil; composed = false; unsettled = nil
        let result = await model.write(request, timeout: PhoneDelivery.timeout(request), retryAnswered: PhoneDelivery.retryAnswered(request), refresh: false)
        writing = nil
        switch result {
        case let .done(value):
            if kind == "commit" {
                outcome = "已提交 " + String((value["commit"].string ?? "").prefix(7)); message = ""; skipHooks = false
            } else {
                outcome = "已推送到 " + PhoneConversation.visible((value["remote"].string ?? "") + "/" + (value["ref"].string ?? "").replacingOccurrences(of: "refs/heads/", with: ""))
                    + " · " + String((value["sha"].string ?? "").prefix(7)) + (value["setUpstream"].bool ? " · 已设为上游" : "")
            }
            committed = true
        case let .refused(value):
            refusal = (kind, value)
            // The switch is for one commit: off after each answered one, kept for a retry of an unknown one.
            if kind == "commit" && value.code != "host-updating" { skipHooks = false }
        case let .unknown(refused): unsettled = refused
        case let .failed(error): refusal = (kind, NativeHostRefusal(status: 0, code: "request-failed", message: (error as? NativeFailure)?.errorDescription ?? "暂时无法完成，请稍后重试。", details: .null))
        }
        await load()
    }
}

/** A detail behind ⓘ, never a sentence under a control. */
struct InfoHint: View {
    let text: String
    @State private var shown = false
    var body: some View {
        Button { shown = true } label: { Image(systemName: "info.circle").font(.system(size: 12)) }
            .buttonStyle(.plain).foregroundStyle(PhoneTheme.muted).accessibilityLabel("说明")
            .popover(isPresented: $shown) { Text(text).font(PhoneTheme.caption).padding(14).frame(idealWidth: 280).presentationCompactAdaptation(.popover) }
    }
}

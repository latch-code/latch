import Charts
import LatchNativeCore
import SwiftUI

enum UsageTab: Hashable, Identifiable {
    case quota, usage
    var id: Self { self }
}

/** The toolbar's way into 额度与用量: a gauge, amber or red by the worst limit that still holds, plain otherwise. */
struct UsageToolbarButton: View {
    @EnvironmentObject private var model: PhoneModel
    @State private var showing = false
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { _ in
            let worst = PhoneUsage.worst(model.snapshot["catalog"], now: model.hostNow())
            Button { showing = true } label: {
                switch worst {
                case .limited: Image(systemName: "gauge.with.dots.needle.67percent").foregroundStyle(PhoneTheme.red)
                case .near: Image(systemName: "gauge.with.dots.needle.67percent").foregroundStyle(PhoneTheme.amberIcon)
                case .ok: Image(systemName: "gauge.with.dots.needle.33percent")
                }
            }
            .accessibilityLabel("额度与用量")
            .accessibilityValue(worst == .limited ? "额度已用尽" : worst == .near ? "额度将用尽" : "")
        }
        .sheet(isPresented: $showing) { UsageSheet().environmentObject(model) }
    }
}

/** 额度与用量: each Harness's subscription limits, and what Latch ran over a period. */
struct UsageSheet: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    @State private var tab: UsageTab
    @State private var reload = 0
    init(tab: UsageTab = .quota) { _tab = State(initialValue: tab) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.usageOffered {
                        Picker("视图", selection: $tab) {
                            Text("额度").tag(UsageTab.quota)
                            Text("用量").tag(UsageTab.usage)
                        }
                        .pickerStyle(.segmented).padding(.bottom, 16)
                    }
                    if tab == .quota || !model.usageOffered { QuotaTab() } else { SpendTab(reload: reload) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 32)
            }
            .refreshable {
                if tab == .quota || !model.usageOffered { await model.refreshQuota() }
                else { reload += 1 }
            }
            .background(PhoneTheme.canvas)
            .navigationTitle("额度与用量").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("关闭")
                }
            }
        }
        // Looking is what asks: on opening, and when a window opens while the sheet is up.
        .task(id: model.hasContentWindow) { await model.refreshQuota() }
    }
}

// MARK: 额度

private struct QuotaTab: View {
    @EnvironmentObject private var model: PhoneModel
    var body: some View {
        // A window past its reset goes within the minute, without asking the Host.
        TimelineView(.periodic(from: .now, by: 60)) { _ in
            let page = PhoneUsage.quotaPage(model.snapshot["catalog"], now: model.hostNow())
            VStack(alignment: .leading, spacing: 0) {
                if page.blocks.isEmpty && page.silent.isEmpty {
                    Text("没有用自己登录的 Harness").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(.vertical, 12)
                }
                ForEach(Array(page.blocks.enumerated()), id: \.element.id) { index, block in
                    if index > 0 { Rectangle().fill(PhoneTheme.line).frame(height: 0.5) }
                    QuotaBlockView(block: block)
                }
                if !page.silent.isEmpty {
                    if !page.blocks.isEmpty { Rectangle().fill(PhoneTheme.line).frame(height: 0.5) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("不报告额度").foregroundStyle(PhoneTheme.muted)
                        Text(page.silent.joined(separator: "、")).foregroundStyle(PhoneTheme.ink2)
                    }
                    .font(PhoneTheme.caption).padding(.vertical, 16)
                }
            }
        }
    }
}

private struct QuotaBlockView: View {
    @EnvironmentObject private var model: PhoneModel
    let block: PhoneQuotaBlock
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                EngineTile(mark: block.mark, size: 20)
                Text(block.name).font(PhoneTheme.row).foregroundStyle(PhoneTheme.ink).lineLimit(1).layoutPriority(1)
                if block.reading { ProgressView().controlSize(.mini).accessibilityLabel("正在读取额度") }
                Spacer(minLength: 8)
                if !block.facts.isEmpty {
                    Text(block.facts.joined(separator: " · ")).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            if block.accountLimited {
                Text("额度已用尽").font(PhoneTheme.caption.weight(.medium)).foregroundStyle(PhoneTheme.red)
            }
            ForEach(Array(block.windows.enumerated()), id: \.element.id) { index, window in
                if let group = window.group, group != (index > 0 ? block.windows[index - 1].group : nil) {
                    Text(group).font(PhoneTheme.caption.weight(.medium)).foregroundStyle(PhoneTheme.muted).padding(.top, index > 0 ? 4 : 0)
                }
                QuotaWindowRow(window: window)
            }
            if let balance = block.balance { Text(balance).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.ink2).monospacedDigit() }
            if let note = block.note {
                HStack(spacing: 6) {
                    Text(note).foregroundStyle(PhoneTheme.muted)
                    if block.retryable, model.canRun, model.hasContentWindow {
                        Text("·").foregroundStyle(PhoneTheme.faint).accessibilityHidden(true)
                        Button("重试") { Task { await model.refreshQuota(retry: true) } }.buttonStyle(.borderless)
                    }
                }
                .font(PhoneTheme.caption)
            }
            if let observed = block.observed { Text(observed).font(.system(size: 12)).foregroundStyle(PhoneTheme.faint) }
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .contain)
    }
}

private struct QuotaWindowRow: View {
    let window: PhoneQuotaWindow
    private var tone: Color { window.state == .limited ? PhoneTheme.red : window.state == .near ? PhoneTheme.amber : PhoneTheme.ink2 }
    var body: some View {
        if let percent = window.percent {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(window.name).foregroundStyle(PhoneTheme.ink)
                    Spacer()
                    Text(window.used).foregroundStyle(window.state == .ok ? PhoneTheme.ink2 : tone).monospacedDigit()
                }
                .font(.system(size: 14))
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(PhoneTheme.line)
                        Capsule().fill(window.state == .ok ? PhoneTheme.ink2 : tone)
                            .frame(width: percent == 0 ? 0 : max(6, proxy.size.width * CGFloat(percent) / 100))
                    }
                }
                .frame(height: 6)
                .accessibilityHidden(true)
                if let reset = window.reset { Text(reset).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted) }
                if let pace = window.pace { Text(pace).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(window.name)
            .accessibilityValue([window.used, window.reset, window.pace].compactMap { $0 }.joined(separator: "，"))
        } else {
            HStack {
                Text(window.name).foregroundStyle(PhoneTheme.ink)
                Spacer()
                Text([window.status, window.reset].compactMap { $0 }.joined(separator: " · ")).foregroundStyle(window.state == .ok ? PhoneTheme.muted : tone)
            }
            .font(.system(size: 14))
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: 用量

private struct SpendTab: View {
    @EnvironmentObject private var model: PhoneModel
    let reload: Int
    @State private var period = "30"
    @State private var group = "harness"
    @State private var shown: (key: String, summary: PhoneUsageSummary)?
    @State private var failed: String?
    @State private var attempt = 0
    @State private var opening = false
    private var key: String { "\(period):\(group)" }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if !model.hasContentWindow {
                Button {
                    opening = true
                    Task { await model.openUsageWindow(); opening = false }
                } label: {
                    HStack(spacing: 8) {
                        if opening { ProgressView().controlSize(.small) }
                        Text("查看用量")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered).controlSize(.large).disabled(opening || !model.connected).padding(.top, 24)
            } else {
                Picker("统计期间", selection: $period) {
                    Text("24 小时").tag("1"); Text("7 天").tag("7"); Text("30 天").tag("30"); Text("90 天").tag("90")
                }
                .pickerStyle(.segmented)
                if let failed {
                    HStack(spacing: 8) {
                        Text(failed).foregroundStyle(PhoneTheme.red)
                        Button("重试") { attempt += 1 }.buttonStyle(.borderless)
                    }
                    .font(PhoneTheme.caption)
                }
                if let summary = shown?.summary {
                    SpendSummary(summary: summary, period: shown?.key.split(separator: ":").first.map(String.init) ?? period, group: $group)
                        .opacity(shown?.key == key ? 1 : 0.5)
                } else if failed == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
                }
            }
        }
        .task(id: "\(key):\(model.hasContentWindow):\(attempt):\(reload)") { await load() }
        // A closed window takes what it read with it.
        .onChange(of: model.verifiedUntil) { _, value in if value == nil { shown = nil; failed = nil } }
    }
    private func load() async {
        guard model.hasContentWindow else { shown = nil; return }
        let asked = key
        do {
            let summary = try await model.readUsage(period: period, group: group)
            guard !Task.isCancelled, asked == key else { return }
            shown = (asked, summary); failed = nil
        } catch {
            guard !Task.isCancelled, asked == key, !(error is CancellationError) else { return }
            if (error as? NativeFailure) == .expired { model.report(error); return }
            if model.wentAway(error) { return }
            failed = "用量读取失败"
        }
    }
}

private struct SpendSummary: View {
    @EnvironmentObject private var model: PhoneModel
    let summary: PhoneUsageSummary
    let period: String
    @Binding var group: String
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(summary.tokensText).font(.system(size: 34, weight: .semibold)).monospacedDigit().foregroundStyle(PhoneTheme.ink)
                    Text("tokens").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted)
                }
                if !summary.facts.isEmpty {
                    Text(summary.facts.joined(separator: " · ")).font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).monospacedDigit()
                }
                if !summary.costs.isEmpty {
                    HStack(spacing: 6) {
                        if summary.estimated {
                            Text("估算").font(.system(size: 11, weight: .medium)).foregroundStyle(PhoneTheme.muted)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(PhoneTheme.lineStrong, lineWidth: 0.5))
                        }
                        Text(summary.costs.joined(separator: " + ")).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink2).monospacedDigit()
                    }
                }
                if summary.truncated { Text("记录太多，只算了读到的部分").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.amber) }
            }
            if summary.empty {
                Text("这个期间没有 Latch 运行的用量").font(PhoneTheme.caption).foregroundStyle(PhoneTheme.muted).padding(.vertical, 8)
            } else {
                TokenChart(buckets: summary.buckets, hourly: period == "1")
                Picker("分组", selection: $group) {
                    Text("按 Harness").tag("harness"); Text("按模型").tag("model"); Text("按项目").tag("project")
                }
                .pickerStyle(.segmented)
                VStack(spacing: 0) {
                    ForEach(Array(summary.rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Rectangle().fill(PhoneTheme.line).frame(height: 0.5) }
                        SpendRow(row: row)
                    }
                }
            }
        }
    }
}

private struct TokenChart: View {
    let buckets: [PhoneUsageBucket]
    let hourly: Bool
    /** About five labels whatever the period. */
    private var step: Int { max(1, Int((Double(buckets.count) / 5).rounded(.up))) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(hourly ? "每小时 tokens" : "每日 tokens").font(PhoneTheme.caption.weight(.medium)).foregroundStyle(PhoneTheme.muted)
            Chart(buckets) { bucket in
                BarMark(x: .value("时段", String(bucket.id)), y: .value("tokens", bucket.tokens), width: .ratio(0.7))
                    .foregroundStyle(PhoneTheme.ink2.opacity(0.75))
                    .cornerRadius(1.5)
            }
            .chartXAxis {
                // A category axis labels every bar unless told otherwise: about five, the rest left blank.
                AxisMarks { value in
                    AxisValueLabel(collisionResolution: .disabled) {
                        if let index = value.as(String.self).flatMap({ Int($0) }), buckets.indices.contains(index), index % step == 0 {
                            Text(buckets[index].label).font(.system(size: 10)).foregroundStyle(PhoneTheme.muted)
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(PhoneTheme.line)
                    AxisValueLabel {
                        if let tokens = value.as(Int.self) { Text(PhoneUsage.tokens(tokens)).font(.system(size: 10)).foregroundStyle(PhoneTheme.muted) }
                    }
                }
            }
            .frame(height: 160)
            .accessibilityLabel(hourly ? "每小时 tokens" : "每日 tokens")
        }
    }
}

private struct SpendRow: View {
    @EnvironmentObject private var model: PhoneModel
    let row: PhoneUsageRow
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let harness = row.harnessId { EngineTile(mark: model.engineMark(harness), size: 16).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 } }
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name).font(.system(size: 15)).foregroundStyle(PhoneTheme.ink).lineLimit(1).truncationMode(.middle)
                    if let detail = row.detail { Text(detail).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(row.tokensText).font(.system(size: 15, weight: .medium)).foregroundStyle(PhoneTheme.ink).monospacedDigit()
                    if let cost = row.cost { Text(cost).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).monospacedDigit() }
                }
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(PhoneTheme.line)
                    Capsule().fill(PhoneTheme.ink2.opacity(0.75)).frame(width: row.share > 0 ? max(3, proxy.size.width * row.share) : 0)
                }
            }
            .frame(height: 3)
            .accessibilityHidden(true)
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(Int((row.share * 100).rounded()))%")
    }
}

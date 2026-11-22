import AppIntents
import LatchNativeCore
import SwiftUI
import WidgetKit

// MARK: Settings

/** A Harness the widget's settings offer: those the App last wrote figures for. */
struct QuotaHarnessEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Harness"
    static let defaultQuery = QuotaHarnessQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct QuotaHarnessQuery: EntityQuery {
    private func all() -> [QuotaHarnessEntity] {
        guard case let .shelf(shelf) = QuotaShelfFile.read() else { return [] }
        return shelf["harnesses"].array.compactMap { harness in
            harness["id"].string.map { QuotaHarnessEntity(id: $0, name: PhoneStart.engineName(harness)) }
        }
    }
    func entities(for identifiers: [String]) async throws -> [QuotaHarnessEntity] { all().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [QuotaHarnessEntity] { all() }
}

struct QuotaWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "额度"
    @Parameter(title: "Harness") var harness: QuotaHarnessEntity?
}

// MARK: Timeline

struct QuotaEntry: TimelineEntry {
    let date: Date
    /** The chosen Harness first; empty when the App has written nothing yet. */
    let harnesses: [PhoneQuotaWidgetHarness]
}

struct QuotaProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> QuotaEntry { QuotaEntry(date: Date(), harnesses: [PhoneQuotaWidget.placeholder]) }
    private func entry(_ shelf: NativeJSON?, at date: Date, chosen: String?) -> QuotaEntry {
        QuotaEntry(date: date, harnesses: shelf.map { PhoneQuotaWidget.ordered(PhoneQuotaWidget.harnesses($0, now: date), chosen: chosen) } ?? [])
    }
    func snapshot(for configuration: QuotaWidgetIntent, in context: Context) async -> QuotaEntry {
        guard case let .shelf(shelf) = QuotaShelfFile.read() else { return entry(nil, at: Date(), chosen: nil) }
        return entry(shelf, at: Date(), chosen: configuration.harness?.id)
    }
    /**
     * Redrawn as reset and age words change; the App asks for a new timeline whenever it writes the file. A file the data
     * protection keeps shut before the first unlock is asked for again a quarter of an hour on, rather than drawn as gone.
     */
    func timeline(for configuration: QuotaWidgetIntent, in context: Context) async -> Timeline<QuotaEntry> {
        let now = Date()
        switch QuotaShelfFile.read() {
        case .missing: return Timeline(entries: [entry(nil, at: now, chosen: nil)], policy: .never)
        case .unreadable: return Timeline(entries: [entry(nil, at: now, chosen: nil)], policy: .after(now.addingTimeInterval(PhoneQuotaWidget.staleAfter)))
        case let .shelf(shelf):
            let entries = PhoneQuotaWidget.refreshDates(shelf, now: now).map { entry(shelf, at: $0, chosen: configuration.harness?.id) }
            return Timeline(entries: entries, policy: .atEnd)
        }
    }
}

// MARK: Widget

struct LatchQuotaWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: PhoneQuotaWidget.kind, intent: QuotaWidgetIntent.self, provider: QuotaProvider()) { entry in
            QuotaWidgetView(entry: entry)
        }
        .configurationDisplayName("额度")
        .description("Harness 的用量与重置时间")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular])
    }
}

private extension PhoneQuotaWindow {
    /** 「68%」, or the state's words where the Harness gave no figure. */
    var figure: String { percent.map { "\($0)%" } ?? status ?? "" }
}

private func tone(_ state: PhoneQuotaState?, stale: Bool) -> Color {
    if stale { return PhoneTheme.faint }
    switch state {
    case .limited: return PhoneTheme.red
    case .near: return PhoneTheme.amber
    default: return PhoneTheme.ink2
    }
}

/** The app's 6pt bar: neutral, amber from 80%, red at the limit; faint once the figures are out of date. */
private struct QuotaBar: View {
    let window: PhoneQuotaWindow
    let stale: Bool
    var height: CGFloat = 6
    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(PhoneTheme.line)
                if let percent = window.percent, percent > 0 {
                    Capsule().fill(tone(window.state, stale: stale)).frame(width: max(height, proxy.size.width * CGFloat(percent) / 100))
                } else if window.percent == nil, window.state != .ok {
                    Capsule().fill(tone(window.state, stale: stale))
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

private struct QuotaMark: View {
    let mark: String?
    var size: CGFloat = 16
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Group {
            if let image = EngineTile.smallImage(mark, scheme: scheme, points: size) {
                image.resizable().interpolation(.high).foregroundStyle(PhoneTheme.ink)
            } else {
                Image(systemName: "cpu").resizable().scaledToFit().foregroundStyle(PhoneTheme.muted)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/** 「更新于 20 分钟前」 behind a clock, shown only once the figures are out of date. */
private struct StaleLine: View {
    let harness: PhoneQuotaWidgetHarness
    var body: some View {
        if harness.stale, let observed = harness.observed {
            Label { Text(observed) } icon: { Image(systemName: "clock") }
                .labelStyle(.titleAndIcon).font(.system(size: 11)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
        }
    }
}

private func spoken(_ harness: PhoneQuotaWidgetHarness) -> String {
    var parts = [harness.name]
    if let leading = harness.leading { parts += [leading.name, leading.used] + [leading.reset].compactMap { $0 } }
    else if harness.accountLimited { parts.append("额度已用尽") }
    else { parts.append("打开 Latch 更新") }
    if harness.stale, let observed = harness.observed { parts.append(observed) }
    return parts.joined(separator: "，")
}

struct QuotaWidgetView: View {
    let entry: QuotaEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        content
            .widgetURL(LatchLink.quota)
            .containerBackground(for: .widget) {
                switch family {
                case .accessoryCircular: AccessoryWidgetBackground()
                case .accessoryRectangular: Color.clear
                default: PhoneTheme.canvas
                }
            }
    }
    @ViewBuilder private var content: some View {
        switch family {
        case .systemMedium: medium
        case .accessoryRectangular: rectangular
        case .accessoryCircular: circular
        default: small
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("额度").font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.ink)
            Spacer(minLength: 0)
            Text("打开 Latch 读取").font(.system(size: 12)).foregroundStyle(PhoneTheme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    // MARK: Small: one Harness

    @ViewBuilder private var small: some View {
        if let harness = entry.harnesses.first {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    QuotaMark(mark: harness.mark)
                    Text(harness.name).font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                }
                Spacer(minLength: 4)
                if let leading = harness.leading {
                    Text(leading.name).font(.system(size: 12)).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                    Text(leading.figure).font(.system(size: 30, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(harness.stale ? PhoneTheme.muted : leading.state == .ok ? PhoneTheme.ink : tone(leading.state, stale: false))
                        .lineLimit(1).minimumScaleFactor(0.6)
                    QuotaBar(window: leading, stale: harness.stale).padding(.top, 6).padding(.bottom, 8)
                    if let reset = leading.reset { Text(reset).font(.system(size: 11)).foregroundStyle(PhoneTheme.muted).lineLimit(1) }
                } else {
                    Text(harness.accountLimited ? "额度已用尽" : "打开 Latch 更新").font(.system(size: 12))
                        .foregroundStyle(harness.accountLimited ? PhoneTheme.red : PhoneTheme.muted)
                }
                StaleLine(harness: harness).padding(.top, 2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken(harness))
        } else { empty }
    }

    // MARK: Medium: up to three

    @ViewBuilder private var medium: some View {
        if entry.harnesses.isEmpty { empty } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(entry.harnesses.prefix(3).enumerated()), id: \.element.id) { index, harness in
                    if index > 0 { Spacer(minLength: 6) }
                    MediumRow(harness: harness)
                }
                if entry.harnesses.count < 3 { Spacer(minLength: 0) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    // MARK: Lock Screen: the chosen Harness's worst window

    @ViewBuilder private var rectangular: some View {
        if let harness = entry.harnesses.first {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(harness.name).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    if let leading = harness.leading { Text(leading.figure).font(.headline).monospacedDigit() }
                }
                if let leading = harness.leading {
                    Gauge(value: Double(leading.percent ?? (leading.state == .ok ? 0 : 100)), in: 0...100) { EmptyView() }
                        .gaugeStyle(.accessoryLinearCapacity)
                    if harness.stale, let observed = harness.observed { Label(observed, systemImage: "clock").font(.caption).lineLimit(1) }
                    else { Text(leading.reset ?? leading.name).font(.caption).lineLimit(1) }
                } else {
                    Text(harness.accountLimited ? "额度已用尽" : "打开 Latch 更新").font(.caption)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken(harness))
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text("额度").font(.headline)
                Text("打开 Latch 读取").font(.caption)
            }
        }
    }

    @ViewBuilder private var circular: some View {
        if let harness = entry.harnesses.first, let leading = harness.leading {
            Gauge(value: Double(leading.percent ?? (leading.state == .ok ? 0 : 100)), in: 0...100) {
                EmptyView()
            } currentValueLabel: {
                VStack(spacing: 0) {
                    if let percent = leading.percent { Text("\(percent)").monospacedDigit() } else { Image(systemName: "exclamationmark") }
                    if harness.stale { Image(systemName: "clock").font(.system(size: 8)) }
                }
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken(harness))
        } else {
            Gauge(value: 0, in: 0...100) { EmptyView() } currentValueLabel: { Text("–") }
                .gaugeStyle(.accessoryCircularCapacity)
                .accessibilityLabel(entry.harnesses.first.map(spoken) ?? "额度，打开 Latch 读取")
        }
    }
}

private struct MediumRow: View {
    let harness: PhoneQuotaWidgetHarness
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                QuotaMark(mark: harness.mark, size: 14)
                Text(harness.name).font(.system(size: 13, weight: .medium)).foregroundStyle(PhoneTheme.ink).lineLimit(1)
                Spacer(minLength: 6)
                if let leading = harness.leading {
                    Text(leading.figure).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                        .foregroundStyle(harness.stale ? PhoneTheme.muted : leading.state == .ok ? PhoneTheme.ink2 : tone(leading.state, stale: false))
                }
            }
            if let leading = harness.leading {
                QuotaBar(window: leading, stale: harness.stale, height: 4)
                HStack(spacing: 6) {
                    Text([leading.name, leading.reset].compactMap { $0 }.joined(separator: " · ")).lineLimit(1)
                    Spacer(minLength: 4)
                    if harness.stale, let observed = harness.observed {
                        Label(observed, systemImage: "clock").labelStyle(.titleAndIcon).lineLimit(1)
                    }
                }
                .font(.system(size: 11)).foregroundStyle(PhoneTheme.muted)
            } else {
                Text(harness.accountLimited ? "额度已用尽" : "打开 Latch 更新").font(.system(size: 11))
                    .foregroundStyle(harness.accountLimited ? PhoneTheme.red : PhoneTheme.muted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken(harness))
    }
}

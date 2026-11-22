import Foundation
import LatchNativeCore

/** 额度与用量 as the phone reads it: each catalog's blocks and each summary's totals, buckets and rows, as plain values. */
func phoneUsageFixture(_ input: Data) throws -> [String: Any] {
    let vectors = try NativeJSON.decode(input)
    guard let now = PhoneTime.parse(vectors["now"]), let zone = TimeZone(identifier: "UTC") else { throw NativeFailure.invalidRecord }
    let state = { (value: PhoneQuotaState?) -> Any in value.map { ["ok", "near", "limited"][$0.rawValue] } ?? NSNull() }
    let page = PhoneUsage.quotaPage(vectors["catalog"], now: now, timeZone: zone)
    let blocks: [[String: Any]] = page.blocks.map { block in
        [
            "id": block.id, "name": block.name, "state": state(block.state), "facts": block.facts, "balance": block.balance ?? NSNull(),
            "account": block.accountLimited, "reading": block.reading, "note": block.note ?? NSNull(), "retry": block.retryable,
            "observed": block.observed ?? NSNull(),
            "windows": block.windows.map { window -> [String: Any] in
                ["group": window.group ?? NSNull(), "name": window.name, "state": state(window.state), "used": window.used,
                 "reset": window.reset ?? NSNull(), "pace": window.pace ?? NSNull()]
            },
        ]
    }
    let summaries: [Any] = vectors["summaries"].array.map { value in
        guard let summary = PhoneUsage.summary(value, catalog: vectors["catalog"]) else { return NSNull() }
        return [
            "tokens": summary.tokensText, "facts": summary.facts, "costs": summary.costs, "estimated": summary.estimated, "empty": summary.empty,
            "buckets": summary.buckets.map { "\($0.label)=\($0.tokens)" },
            "rows": summary.rows.map { row in
                [row.name, row.detail ?? "-", row.tokensText, String(format: "%.2f", row.share), row.cost ?? "-"].joined(separator: " | ")
            },
        ] as [String: Any]
    }
    return [
        "blocks": blocks, "silent": page.silent, "worst": state(PhoneUsage.worst(vectors["catalog"], now: now)), "summaries": summaries,
        "notices": vectors["catalog"]["harnesses"].array.map { PhoneUsage.limitNotice(vectors["catalog"], harnessId: $0["id"].string ?? "", now: now) ?? "" },
        "tokens": [0, 850, 9_149, 12_400, 99_950, 124_000, 999_499, 999_500, 1_250_000].map(PhoneUsage.tokens),
        "costs": [PhoneUsage.cost(micros: 2_100, currency: "USD"), PhoneUsage.cost(micros: 12_500_000, currency: "CNY"),
                  PhoneUsage.cost(micros: 1_234_567_890, currency: "USD"), PhoneUsage.cost(micros: 0, currency: "USD")],
    ]
}

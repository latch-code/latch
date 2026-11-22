import Foundation
import LatchNativeCore

/**
 * The quota widgets' file as the App writes it from a catalog (`shelf`, then `encoded` with the Host's clock offset), and
 * what the extension draws from those same bytes at each of the given moments on this device's clock.
 */
func phoneQuotaWidgetFixture(_ input: Data) throws -> [String: Any] {
    let vectors = try NativeJSON.decode(input)
    guard let hostNow = PhoneTime.parse(vectors["hostNow"]), case let .number(offset) = vectors["hostOffset"],
          let zone = TimeZone(identifier: "UTC") else { throw NativeFailure.invalidRecord }
    let shelf = PhoneQuotaWidget.shelf(vectors["catalog"], now: hostNow)
    let bytes = try PhoneQuotaWidget.encoded(shelf, hostOffset: offset)
    guard let read = PhoneQuotaWidget.decode(bytes) else { throw NativeFailure.invalidRecord }
    let state = { (value: PhoneQuotaState?) -> Any in value.map { ["ok", "near", "limited"][$0.rawValue] } ?? NSNull() }
    let window = { (value: PhoneQuotaWindow) -> [String: Any] in
        ["name": value.name, "state": state(value.state), "used": value.used, "reset": value.reset ?? NSNull(), "pace": value.pace ?? NSNull()]
    }
    let moments: [Any] = vectors["at"].array.map { moment in
        guard let now = PhoneTime.parse(moment) else { return NSNull() }
        let harnesses = PhoneQuotaWidget.ordered(PhoneQuotaWidget.harnesses(read, now: now, timeZone: zone), chosen: vectors["chosen"].string)
        return harnesses.map { harness -> [String: Any] in
            ["id": harness.id, "name": harness.name, "mark": harness.mark ?? NSNull(), "state": state(harness.state),
             "account": harness.accountLimited, "stale": harness.stale, "observed": harness.observed ?? NSNull(),
             "leading": harness.leading.map(window) ?? NSNull(), "windows": harness.windows.map(window)]
        }
    }
    let deviceNow = hostNow.addingTimeInterval(-offset)
    return [
        "text": String(decoding: bytes, as: UTF8.self),
        "unchanged": PhoneQuotaWidget.shelf(vectors["catalog"], now: hostNow) == shelf,
        "rejected": [Data("{}".utf8), Data(#"{"version":2,"harnesses":[]}"#.utf8), Data(repeating: 32, count: 40_000)].map { PhoneQuotaWidget.decode($0) == nil },
        "moments": moments,
        "dates": PhoneQuotaWidget.refreshDates(read, now: deviceNow).map(PhoneTime.format),
    ]
}

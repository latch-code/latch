import Foundation

/**
 * The three places for a face's motion that draws the eye (a squint, a popping ?, a moving cursor or z), shared by every
 * face on screen: a face takes one for a while; one that keeps a loop going gives it up after its turn and rests before
 * asking again, so the places pass around and no more than three faces move such things at once.
 */
public struct PhoneFaceSlots: Sendable {
    public static let limit = 3
    private var until: [String: TimeInterval] = [:]
    private var rest: [String: TimeInterval] = [:]
    /** Faces turned away, by when they first asked and last asked: a free place goes to the one waiting longest. */
    private var waiting: [String: (since: TimeInterval, last: TimeInterval)] = [:]
    public init() {}
    /** Takes or keeps a place for `id`; false while all three are held or it is resting after its last turn. */
    public mutating func take(_ id: String, now: TimeInterval, for seconds: Double, resting: Double = 0) -> Bool {
        until = until.filter { $0.value > now }
        rest = rest.filter { $0.value > now }
        // A face that stopped asking (gone, still, or moving nothing) no longer holds its place in the queue.
        waiting = waiting.filter { $0.value.last > now - 1 }
        if until[id] != nil { return true }
        if rest[id] != nil { return false }
        let since = waiting[id]?.since ?? now
        let ahead = waiting.filter { $0.key != id && $0.value.since < since }.count
        guard until.count + ahead < Self.limit else {
            waiting[id] = (since, now)
            return false
        }
        waiting.removeValue(forKey: id)
        until[id] = now + seconds
        if resting > 0 { rest[id] = now + seconds + resting }
        return true
    }
    /** Gives a place back at once, as when a face stops running or goes away. */
    public mutating func release(_ id: String) { until.removeValue(forKey: id); waiting.removeValue(forKey: id) }
    public func holds(_ id: String, now: TimeInterval) -> Bool { (until[id] ?? 0) > now }
    public func held(now: TimeInterval) -> Int { until.values.filter { $0 > now }.count }
}

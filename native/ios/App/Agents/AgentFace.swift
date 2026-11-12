import Combine
import LatchNativeCore
import SwiftUI
import UIKit

/**
 * An Agent's face, drawn as the web draws it: brackets around two eyes on a 40 grid, round caps and joins, on a plate of
 * 13% of its hue. From 32pt it blinks, glances and now and then squints, and wears a prop for its state: a blinking `_`
 * while running, an amber ? while it waits for you, a red ! after a failure, closed eyes and a drifting z while it
 * cannot start. 20–31pt only blinks; smaller stands still. Reduce Motion, and the screenshot build, keep it still with
 * the props at rest. The state word always stands beside it; the face is decorative.
 */
struct AgentFace: View {
    let avatar: PhoneAgentAvatar
    let size: CGFloat
    var face: PhoneAgentFace = .idle
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    // Each motion is a keyframe animation started by bumping its counter; no face keeps a timer of its own.
    @State private var blinks = 0
    @State private var glances = 0
    @State private var glance = CGSize.zero
    @State private var glanceHold = 1.0
    @State private var squints = 0
    @State private var squintHold = 1.0
    @State private var asks = 0
    @State private var phase = 0.0
    @State private var next: TimeInterval = 0
    @State private var shown = false
    /** Whether this face counts among the clock's viewers; leaving goes by this, not by what `still` is now. */
    @State private var joined = false
    /** This face's own place in its loops, so cursors and z's never move in step, and its name for the shared places. */
    @State private var offset = Double.random(in: 0..<3.2)
    @State private var slot = UUID().uuidString
    @State private var looping = false

    private enum Tier { case full, blink, still }
    private var tier: Tier { size >= 32 ? .full : size >= 20 ? .blink : .still }
    private var still: Bool {
        #if LATCH_SCREENS
        true
        #else
        reduceMotion || tier == .still
        #endif
    }
    private var hue: Color { PhoneTheme.agentHue(avatar.hue) }
    private var props: Bool { tier == .full }
    private var gaze: CGSize {
        guard props else { return .zero }
        switch face {
        case .running: return CGSize(width: 1.2, height: 0.8)
        case .waiting: return CGSize(width: 0, height: -0.8)
        case .failed: return CGSize(width: 0, height: 0.9)
        default: return .zero
        }
    }

    var body: some View {
        let scale = size / 40
        ZStack {
            RoundedRectangle(cornerRadius: 13 * scale).fill(PhoneTheme.agentPlate(avatar.hue))
            ForEach(FaceGeometry.brackets[avatar.bracket] ?? [], id: \.self) { d in
                GridPath(d: d).stroke(hue, style: StrokeStyle(lineWidth: 2.3 * scale, lineCap: .round, lineJoin: .round))
            }
            ZStack {
                if face == .resting {
                    eyes("shut")
                } else {
                    eyes(avatar.eyes)
                        .keyframeAnimator(initialValue: 1.0, trigger: squints) { content, value in content.opacity(value) } keyframes: { _ in
                            KeyframeTrack { LinearKeyframe(0, duration: 0.18); LinearKeyframe(0, duration: squintHold); LinearKeyframe(1, duration: 0.18) }
                        }
                    if props {
                        eyes("arc")
                            .keyframeAnimator(initialValue: 0.0, trigger: squints) { content, value in content.opacity(value) } keyframes: { _ in
                                KeyframeTrack { LinearKeyframe(1, duration: 0.18); LinearKeyframe(1, duration: squintHold); LinearKeyframe(0, duration: 0.18) }
                            }
                    }
                }
            }
            .keyframeAnimator(initialValue: CGSize.zero, trigger: glances) { content, value in
                content.offset(x: value.width * scale, y: value.height * scale)
            } keyframes: { _ in
                KeyframeTrack { CubicKeyframe(glance, duration: 0.4); LinearKeyframe(glance, duration: glanceHold); CubicKeyframe(.zero, duration: 0.45) }
            }
            .offset(x: gaze.width * scale, y: gaze.height * scale)
            .animation(still ? nil : .easeInOut(duration: 0.5), value: gaze)
            if props { prop(scale) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onAppear { shown = true; syncClock() }
        .onDisappear { shown = false; syncClock() }
        .onChange(of: reduceMotion) { _, _ in syncClock() }
        .onReceive(AgentFaceClock.shared.ticks) { now in if !still && shown { tick(now) } }
        // 刚完成: a run that ends while the face is shown gets one squint.
        .onChange(of: face) { old, new in
            if looping && new != .running && new != .resting { looping = false; AgentFaceClock.shared.release(slot) }
            if old == .running && new == .idle && !still && props { squint(AgentFaceClock.shared.now(), for: 1.8) }
        }
    }

    @ViewBuilder private func eyes(_ kind: String) -> some View {
        ForEach(FaceGeometry.eyeX, id: \.self) { x in
            let eye = FaceGeometry.eye(kind, x: x)
            Group {
                if eye.filled { GridPath(d: eye.d).fill(hue) }
                else { GridPath(d: eye.d).stroke(hue, style: StrokeStyle(lineWidth: eye.width * size / 40, lineCap: .round, lineJoin: .round)) }
            }
            .keyframeAnimator(initialValue: 1.0, trigger: blinks) { content, value in
                content.scaleEffect(x: 1, y: value, anchor: UnitPoint(x: x / 40, y: eye.centerY / 40))
            } keyframes: { _ in
                KeyframeTrack { CubicKeyframe(0.12, duration: 0.07); CubicKeyframe(1, duration: 0.09) }
            }
        }
    }

    @ViewBuilder private func prop(_ scale: CGFloat) -> some View {
        switch face {
        case .running:
            RoundedRectangle(cornerRadius: 0.9 * scale).fill(hue)
                .frame(width: 4 * scale, height: 1.8 * scale)
                .position(x: 33 * scale, y: 28.1 * scale)
                .opacity(still || !looping || Int((phase + offset) * 2) % 2 == 0 ? 1 : 0)
        case .waiting:
            ZStack {
                GridPath(d: FaceGeometry.ask).stroke(PhoneTheme.amberIcon, style: StrokeStyle(lineWidth: 1.5 * scale, lineCap: .round, lineJoin: .round))
                GridPath(d: FaceGeometry.dot(33.6, 11.6, 0.95)).fill(PhoneTheme.amberIcon)
            }
            .keyframeAnimator(initialValue: 0.0, trigger: asks) { content, value in
                // Still, the ? always shows; moving, it comes and goes with its keyframes.
                content.opacity(still ? 1 : value).scaleEffect(still ? 1 : 0.4 + 0.6 * value, anchor: UnitPoint(x: 33.6 / 40, y: 8.4 / 40))
            } keyframes: { _ in
                KeyframeTrack { SpringKeyframe(1, duration: 0.3); LinearKeyframe(1, duration: 1.2); CubicKeyframe(0, duration: 0.3) }
            }
        case .failed:
            ZStack {
                GridPath(d: FaceGeometry.alert).stroke(PhoneTheme.red, style: StrokeStyle(lineWidth: 1.7 * scale, lineCap: .round))
                GridPath(d: FaceGeometry.dot(33.6, 11.6, 1)).fill(PhoneTheme.red)
            }
        case .resting:
            let drift = still || !looping ? 0 : (phase + offset).truncatingRemainder(dividingBy: 3.2) / 3.2
            GridPath(d: FaceGeometry.sleep).stroke(hue, style: StrokeStyle(lineWidth: 1.3 * scale, lineCap: .round, lineJoin: .round))
                .offset(x: drift * 3 * scale, y: (2 - drift * 8) * scale)
                .opacity(still || !looping ? 1 : drift < 0.25 ? drift * 4 : 1 - (drift - 0.25) / 0.75)
                .animation(still || !looping ? nil : .linear(duration: AgentFaceClock.tick), value: phase)
        case .idle:
            EmptyView()
        }
    }

    /** Joins the shared clock while shown and moving, and leaves it exactly once, whatever changed in between. */
    private func syncClock() {
        let wanted = shown && !still
        if wanted && !joined { joined = true; AgentFaceClock.shared.join() }
        else if !wanted && joined { joined = false; looping = false; AgentFaceClock.shared.release(slot); AgentFaceClock.shared.leave() }
    }

    /** One step of the shared clock: perhaps one motion, never more than three squints or props on screen at once. */
    private func tick(_ now: TimeInterval) {
        phase = now
        // The cursor or z moves only while this face holds one of the three places; otherwise it stands at rest.
        if props && (face == .running || face == .resting) { looping = AgentFaceClock.shared.loop(slot, now) }
        else if looping { looping = false; AgentFaceClock.shared.release(slot) }
        if next == 0 { next = now + .random(in: 0.4...2.2); return }
        guard now >= next else { return }
        func after(_ range: ClosedRange<Double>) { next = now + .random(in: range) }
        if tier != .full || face == .running || face == .failed {
            blinks += 1
            after(tier == .full ? 3...5.5 : 5...11)
            return
        }
        if face == .resting { after(5...6); return }
        if face == .waiting {
            if AgentFaceClock.shared.feature(slot, now, for: 1.8) { asks += 1 } else { blinks += 1 }
            after(3.6...4.8)
            return
        }
        let roll = Double.random(in: 0..<1)
        if roll < 0.55 { blinks += 1 }
        else if roll < 0.85 {
            glance = CGSize(width: .random(in: -1.4...1.4), height: .random(in: -0.6...0.4))
            glanceHold = .random(in: 0.4...0.9)
            glances += 1
        } else if !squint(now, for: 1.4) { blinks += 1 }
        after(2.6...5.2)
    }
    @discardableResult private func squint(_ now: TimeInterval, for seconds: Double) -> Bool {
        guard AgentFaceClock.shared.feature(slot, now, for: seconds) else { return false }
        squintHold = max(0.2, seconds - 0.36)
        squints += 1
        return true
    }
}

/**
 * The one clock every face on screen listens to: it ticks only while a face is shown and the App is active, and it
 * keeps squints and props to three at once.
 */
@MainActor final class AgentFaceClock {
    static let shared = AgentFaceClock()
    static let tick = 0.25
    let ticks = PassthroughSubject<TimeInterval, Never>()
    private var viewers = 0
    private var timer: Timer?
    private var active = true
    private var slots = PhoneFaceSlots()
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { AgentFaceClock.shared.active = false; AgentFaceClock.shared.refresh() }
        })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { AgentFaceClock.shared.active = true; AgentFaceClock.shared.refresh() }
        })
    }
    func now() -> TimeInterval { Date.timeIntervalSinceReferenceDate }
    func join() { viewers += 1; refresh() }
    func leave() { viewers = max(0, viewers - 1); refresh() }
    /** Takes one of the three places for a squint or a popping ?, if one is free. */
    func feature(_ id: String, _ now: TimeInterval, for seconds: Double) -> Bool { slots.take(id, now: now, for: seconds) }
    /** A turn for a looping prop (the cursor, the z): six seconds, then four at rest so the place passes to another face. */
    func loop(_ id: String, _ now: TimeInterval) -> Bool { slots.take(id, now: now, for: 6, resting: 4) }
    func release(_ id: String) { slots.release(id) }
    private func refresh() {
        if viewers > 0 && active && timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { _ in
                MainActor.assumeIsolated { AgentFaceClock.shared.ticks.send(AgentFaceClock.shared.now()) }
            }
        } else if (viewers == 0 || !active), let running = timer {
            running.invalidate()
            timer = nil
        }
    }
}

/** The face's geometry, the same numbers as the web's (apps/web/src/agents/avatarFace.ts). */
enum FaceGeometry {
    static let brackets: [String: [String]] = [
        "round": ["M13.6 12.8 Q8.6 20.5 13.6 28.2", "M26.4 12.8 Q31.4 20.5 26.4 28.2"],
        "curly": [
            "M14.2 12.6 C11.4 12.6 11.9 14.6 11.9 16.9 C11.9 18.9 11.3 20.5 9.4 20.5 C11.3 20.5 11.9 22.1 11.9 24.1 C11.9 26.4 11.4 28.4 14.2 28.4",
            "M25.8 12.6 C28.6 12.6 28.1 14.6 28.1 16.9 C28.1 18.9 28.7 20.5 30.6 20.5 C28.7 20.5 28.1 22.1 28.1 24.1 C28.1 26.4 28.6 28.4 25.8 28.4",
        ],
        "square": ["M13.8 13 H12.2 Q10.6 13 10.6 14.6 V26.4 Q10.6 28 12.2 28 H13.8", "M26.2 13 H27.8 Q29.4 13 29.4 14.6 V26.4 Q29.4 28 27.8 28 H26.2"],
        "angle": ["M13.4 14 L10 20.5 L13.4 27", "M26.6 14 L30 20.5 L26.6 27"],
    ]
    static let eyeX: [CGFloat] = [16.9, 23.1]
    static let ask = "M31.7 6.9 Q31.8 5.1 33.6 5.1 Q35.4 5.1 35.4 6.8 Q35.4 8.1 34 8.7 Q33.6 8.9 33.6 9.7"
    static let alert = "M33.6 5.2 V9.2"
    static let sleep = "M32.2 6.6 H35.2 L32.2 10.4 H35.2"
    struct Eye { let d: String; let filled: Bool; let width: CGFloat; let centerY: CGFloat }
    static func eye(_ kind: String, x: CGFloat) -> Eye {
        switch kind {
        case "oval": Eye(d: ellipse(x, 21.1, 1.6, 2.35), filled: true, width: 0, centerY: 21.1)
        case "arc": Eye(d: "M\(x - 1.7) 22.1 Q\(x) 19.4 \(x + 1.7) 22.1", filled: false, width: 1.9, centerY: 21)
        case "sleepy", "shut": Eye(d: "M\(x - 1.5) 21.4 H\(x + 1.5)", filled: false, width: 2, centerY: 21.4)
        default: Eye(d: dot(x, 21.2, 2.15), filled: true, width: 0, centerY: 21.2)
        }
    }
    static func dot(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> String { ellipse(x, y, r, r) }
    /** An ellipse as four quarter curves, in the path words GridPath reads. */
    static func ellipse(_ x: CGFloat, _ y: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> String {
        let k: CGFloat = 0.5523
        return "M\(x - rx) \(y) C\(x - rx) \(y - ry * k) \(x - rx * k) \(y - ry) \(x) \(y - ry) C\(x + rx * k) \(y - ry) \(x + rx) \(y - ry * k) \(x + rx) \(y) "
            + "C\(x + rx) \(y + ry * k) \(x + rx * k) \(y + ry) \(x) \(y + ry) C\(x - rx * k) \(y + ry) \(x - rx) \(y + ry * k) \(x - rx) \(y) Z"
    }
}

/** A path in absolute M, L, H, V, Q, C and Z on the 40 grid, scaled to the frame. */
struct GridPath: Shape {
    let d: String
    func path(in rect: CGRect) -> Path {
        let scale = rect.width / 40
        var tokens: [String] = []
        var number = ""
        for character in d {
            if character.isLetter { if !number.isEmpty { tokens.append(number); number = "" }; tokens.append(String(character)) }
            else if character == " " || character == "," { if !number.isEmpty { tokens.append(number); number = "" } }
            else { number.append(character) }
        }
        if !number.isEmpty { tokens.append(number) }
        var path = Path(), index = 0, command = "M", current = CGPoint.zero
        func value() -> CGFloat { defer { index += 1 }; return CGFloat(Double(tokens[index]) ?? 0) }
        func point() -> CGPoint { let x = value(); return CGPoint(x: x * scale, y: value() * scale) }
        while index < tokens.count {
            if let first = tokens[index].first, first.isLetter { command = tokens[index]; index += 1; if command == "Z" { path.closeSubpath(); continue } }
            switch command {
            case "M": current = point(); path.move(to: current); command = "L"
            case "L": current = point(); path.addLine(to: current)
            case "H": current = CGPoint(x: value() * scale, y: current.y); path.addLine(to: current)
            case "V": current = CGPoint(x: current.x, y: value() * scale); path.addLine(to: current)
            case "Q": let control = point(); current = point(); path.addQuadCurve(to: current, control: control)
            case "C": let one = point(), two = point(); current = point(); path.addCurve(to: current, control1: one, control2: two)
            default: index += 1
            }
        }
        return path
    }
}

/** The state word beside a face: 运行中 in ink, 等你处理 in amber, 失败 in red. */
struct FaceWord: View {
    let face: PhoneAgentFace
    let words: String
    var body: some View {
        Text(words).font(.system(size: 12, weight: .medium))
            .foregroundStyle(face == .waiting ? PhoneTheme.amber : face == .failed ? PhoneTheme.red : PhoneTheme.muted)
    }
}

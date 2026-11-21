import ActivityKit
import LatchNativeCore
import SwiftUI

/** A single public indicator; the matching sessions and the answer flow stay in the app. */
@MainActor private final class QuestionLiveActivity: ObservableObject {
    typealias Live = Activity<LatchQuestionAttributes>
    private var requestedFor: String?
    private var ending = Set<String>()
    private var updating: String?

    func reconcile(_ attention: PhoneQuestionAttention?, enabled: Bool, active: Bool) {
        let permitted = enabled && ActivityAuthorizationInfo().areActivitiesEnabled
        // The model withdraws its data while suspended. The last generic reminder goes stale on its own.
        guard active || !permitted else { return }
        let activities = Live.activities.filter { !ending.contains($0.id) }
        guard permitted, let attention, !attention.entries.isEmpty else {
            requestedFor = nil
            for activity in activities { end(activity) }
            return
        }
        let content = ActivityContent(state: LatchQuestionAttributes.ContentState(), staleDate: Date().addingTimeInterval(120))
        if let existing = activities.first {
            for extra in activities.dropFirst() { end(extra) }
            requestedFor = attention.computer
            let id = existing.id
            if (existing.content.staleDate?.timeIntervalSinceNow ?? 0) < 60, updating != id {
                updating = id
                Task {
                    await Self.refresh(id: id, content: content)
                    if updating == id { updating = nil }
                }
            }
        } else if requestedFor != attention.computer {
            // A person may have dismissed it. Let the same uninterrupted wait stay dismissed.
            if (try? Live.request(attributes: .init(), content: content, pushType: nil)) != nil {
                requestedFor = attention.computer
            }
        }
    }
    private func end(_ activity: Live) {
        let id = activity.id
        ending.insert(id)
        Task {
            await Self.finish(id: id)
            ending.remove(id)
        }
    }
    private nonisolated static func refresh(id: String, content: ActivityContent<LatchQuestionAttributes.ContentState>) async {
        await Live.activities.first { $0.id == id }?.update(content)
    }
    private nonisolated static func finish(id: String) async {
        await Live.activities.first { $0.id == id }?.end(nil, dismissalPolicy: .immediate)
    }
}

struct QuestionLiveActivityObserver: ViewModifier {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.scenePhase) private var phase
    @AppStorage(PhoneQuestionReminders.enabledKey) private var enabled = true
    @StateObject private var activity = QuestionLiveActivity()

    func body(content: Content) -> some View {
        content
            .onChange(of: model.questionAttention, initial: true) { _, _ in sync() }
            .onChange(of: phase) { _, _ in sync() }
            .onChange(of: enabled) { _, _ in sync() }
            .onChange(of: model.lastConfirmed) { _, _ in sync() }
    }
    private func sync() { activity.reconcile(model.questionAttention, enabled: enabled, active: phase == .active) }
}

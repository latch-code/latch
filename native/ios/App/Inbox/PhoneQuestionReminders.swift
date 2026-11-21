import LatchNativeCore
import SwiftUI
import UIKit

/** Report the drawer that is already answering a question without exposing its contents. */
struct VisibleQuestionSession: PreferenceKey {
    static let defaultValue: String? = nil
    static func reduce(value: inout String?, nextValue: () -> String?) {
        if let next = nextValue() { value = next }
    }
}

struct PhoneQuestionReminders: ViewModifier {
    static let enabledKey = "LatchQuestionReminders"
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @AppStorage(Self.enabledKey) private var enabled = true
    @State private var visibleSession: String?
    @State private var reminder: Reminder?

    private struct Reminder: Equatable {
        let computer: String
        let session: String
        let count: Int
    }

    func body(content: Content) -> some View {
        content
            .onPreferenceChange(VisibleQuestionSession.self) { visibleSession = $0 }
            .onChange(of: model.questionAttention) { old, new in
                guard enabled, phase == .active, let new else { reminder = nil; return }
                if let entry = new.newlyWaiting(since: old, excluding: visibleSession) {
                    reminder = Reminder(computer: new.computer, session: entry.session, count: entry.count)
                } else if let reminder, reminder.computer != new.computer || !new.sessions.contains(reminder.session) {
                    self.reminder = nil
                }
            }
            .onChange(of: visibleSession) { _, session in
                if reminder?.session == session { reminder = nil }
            }
            .onChange(of: phase) { _, next in if next != .active { reminder = nil } }
            .onChange(of: enabled) { _, on in if !on { reminder = nil } }
            .overlay(alignment: .top) {
                if enabled, phase == .active, let reminder, let attention = model.questionAttention,
                   attention.computer == reminder.computer, attention.sessions.contains(reminder.session), reminder.session != visibleSession {
                    banner(reminder)
                        .task(id: reminder) {
                            if voiceOver {
                                UIAccessibility.post(notification: .announcement, argument: "有问题等你回答")
                                return
                            }
                            do { try await Task.sleep(for: .seconds(8)) } catch { return }
                            if self.reminder == reminder { self.reminder = nil }
                        }
                }
            }
    }

    private func banner(_ target: Reminder) -> some View {
        HStack(spacing: 0) {
            Button {
                reminder = nil
                Task { await model.requestPendingQuestion(computer: target.computer, session: target.session) }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "questionmark.bubble.fill").foregroundStyle(PhoneTheme.amberIcon)
                    Text("有问题等你回答").font(.subheadline.weight(.medium))
                    Spacer(minLength: 4)
                    Text("去回答").font(.subheadline).foregroundStyle(PhoneTheme.accent)
                }
                .padding(.leading, 14).padding(.vertical, 8).frame(minHeight: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("有问题等你回答，去回答")
            Button { reminder = nil } label: {
                Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(PhoneTheme.muted)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("关闭提问提醒")
        }
        .buttonStyle(.plain).foregroundStyle(PhoneTheme.ink)
        .background {
            RoundedRectangle(cornerRadius: 16).fill(PhoneTheme.raised).shadow(color: .black.opacity(0.14), radius: 8, y: 2)
        }
        .frame(maxWidth: 460).padding(.horizontal, 12).padding(.top, 4)
    }
}

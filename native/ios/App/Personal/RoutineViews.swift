import Foundation
import LatchNativeCore
import SwiftUI

struct PersonalRoutineRow: View {
    @EnvironmentObject private var model: PhoneModel
    let routine: NativeJSON
    let edit: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: edit) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "clock").font(.system(size: 18)).foregroundStyle(.secondary).frame(width: 24)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(routine["name"].string ?? "例行任务").foregroundStyle(.primary)
                        Text("每天 " + (routine["schedule"]["time"].string ?? "") + " · " + (routine["schedule"]["timeZone"].string ?? "")).font(.caption).foregroundStyle(.secondary)
                        Text(stateText).font(.caption).foregroundStyle(routine["state"].string == "paused" ? Color.orange : .secondary)
                    }
                    Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
            }.buttonStyle(.plain)
            if let reason = routine["pauseReason"].string { Text(reasonText(reason)).font(.caption).foregroundStyle(.secondary) }
            HStack {
                if routine["enabled"].bool {
                    Button("暂停以后执行") { Task { await model.mutate(.post, path: "/link/api/personal/routines/" + routine.id + "/enabled", fields: ["baseRevision": routine["revision"], "enabled": .bool(false)]) } }.disabled(!model.canRun || model.busy || !model.pending.isEmpty)
                } else { Text("在电脑上开启").foregroundStyle(.secondary) }
                Spacer()
                if let session = routine["lastRun"]["sessionId"].string { Button("查看最近执行") { Task { await model.openSession(session) } } }
            }.font(.caption)
        }.padding(.vertical, 5)
    }
    private var stateText: String {
        switch routine["state"].string { case "ready": "已开启"; case "running": "正在执行"; case "paused": "已暂停"; default: "尚未开启" }
    }
    private func reasonText(_ reason: String) -> String {
        switch reason {
        case "definition-changed": "助手配置已改变，请在电脑上检查并重新开启。"
        case "owner-unavailable": "电脑授权已变化，请在电脑上重新开启。"
        case "harness-unavailable", "plugin-unavailable": "执行方式或插件暂不可用，请检查电脑上的配置。"
        case "missed": "错过的时间不会自动补跑，请在电脑上重新开启。"
        case "audit-unavailable": "电脑暂时无法记录执行，请检查后重新开启。"
        default: "上次结果尚未确认，请先查看实际会话。"
        }
    }
}

struct PersonalRoutineEditor: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let routine: NativeJSON
    @State private var name = ""
    @State private var prompt = ""
    @State private var assistantId = ""
    @State private var time = Date()
    @State private var timeZone = TimeZone.current.identifier
    @State private var deleting = false
    private var editing: Bool { routine["id"].string != nil }
    private var running: Bool { routine["state"].string == "running" }
    private var choices: [NativeJSON] { model.personalOverview["assistants"].array.filter { $0["canSchedule"].bool || $0.id == assistantId } }
    var body: some View {
        NavigationStack {
            Form {
                PersonalPendingWrites()
                Section("名称") { LocalTextEditor(text: $name, placeholder: "例如：每天整理灵感", maximumLines: 2).frame(minHeight: 36) }
                Section("执行助手") {
                    if choices.isEmpty { Text("先创建一个可用的内置个人助手。").foregroundStyle(.secondary) }
                    Picker("个人助手", selection: $assistantId) { ForEach(choices, id: \.id) { Text($0["name"].string ?? "助手").tag($0.id) } }.disabled(running)
                }
                Section("要做的事") { LocalTextEditor(text: $prompt, placeholder: "描述这个助手每天要完成的任务", maximumLines: 12).frame(minHeight: 150).disabled(running) }
                Section {
                    DatePicker("每天", selection: $time, displayedComponents: .hourAndMinute).disabled(running)
                    LabeledContent("时区") { LocalTextEditor(text: $timeZone, placeholder: "Asia/Shanghai", maximumLines: 1).frame(minHeight: 30) }.disabled(running)
                } header: { Text("时间") } footer: { Text("保存后请在电脑上明确开启。电脑离线错过的时间不会自动补跑。修改执行内容后需要重新开启。") }
                if let session = routine["lastRun"]["sessionId"].string { Section { Button("查看最近执行") { dismiss(); Task { await model.openSession(session) } } } }
                if editing { Section { Button("删除例行任务", role: .destructive) { deleting = true }.disabled(running || !model.canRun || !model.pending.isEmpty) } }
            }
            .navigationTitle(editing ? "例行任务" : "创建例行任务").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { clear(); dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(!valid || model.busy || !model.pending.isEmpty) }
            }
            .confirmationDialog("删除这个例行任务？", isPresented: $deleting, titleVisibility: .visible) { Button("删除例行任务", role: .destructive) { Task { if await model.mutate(.delete, path: "/link/api/personal/routines/" + routine.id, fields: [:]), model.pending.isEmpty { clear(); dismiss() } } } }
            .onAppear {
                name = routine["name"].string ?? ""; prompt = routine["prompt"].string ?? ""
                assistantId = routine["assistantId"].string ?? choices.first?.id ?? ""
                timeZone = routine["schedule"]["timeZone"].string ?? TimeZone.current.identifier
                if let saved = routine["schedule"]["time"].string {
                    let parts = saved.split(separator: ":").compactMap { Int($0) }
                    if parts.count == 2 { time = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()) ?? Date() }
                }
            }
            .onChange(of: model.contentGeneration) { _, _ in clear(); dismiss() }
            .onChange(of: model.selectedHost?.id) { _, _ in clear(); dismiss() }
        }
    }
    private var valid: Bool { model.canRun && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && prompt.count <= 16000 && TimeZone(identifier: timeZone) != nil && choices.contains { $0.id == assistantId && $0["canSchedule"].bool } }
    private func clear() { name = ""; prompt = ""; assistantId = ""; timeZone = ""; time = Date(); deleting = false }
    private func save() async {
        let components = Calendar.current.dateComponents([.hour, .minute], from: time)
        var fields: [String: NativeJSON] = ["name": .string(name), "assistantId": .string(assistantId), "prompt": .string(prompt), "schedule": .object(["kind": .string("daily"), "time": .string(String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)), "timeZone": .string(timeZone)])]
        if editing { fields["baseRevision"] = routine["revision"] }
        if running { fields = ["name": .string(name), "baseRevision": routine["revision"]] }
        if await model.mutate(editing ? .patch : .post, path: "/link/api/personal/routines" + (editing ? "/" + routine.id : ""), fields: fields), model.pending.isEmpty { clear(); dismiss() }
    }
}

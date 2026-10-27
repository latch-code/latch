import Foundation
import LatchNativeCore

struct PhoneGroupControl { let groupId: String; let turnId: String; var state: String
    var active: Bool { ["running", "waiting-approval"].contains(state) }
}

extension PhoneModel {
    var supportsPersonal: Bool { snapshot["catalog"]["features"]["personal"].bool }
    var supportsGroups: Bool { snapshot["catalog"]["features"]["personalGroups"].bool }
    var supportsRoutines: Bool { snapshot["catalog"]["features"]["personalRoutines"].bool }
    func openPersonalHome() async {
        area = .personal; assistantId = nil; groupId = nil; groupControl = nil; groupDetail = .null; sessionId = nil; detail = .null; assistantDetail = .null
        contentGeneration = UUID(); PreviewFiles.clear(); startEvents()
        await refreshPersonal()
    }
    func openAssistant(_ id: String) async {
        guard id.range(of: "^asst_[a-f0-9-]{36}$", options: .regularExpression) != nil else { return }
        area = .personal; assistantId = id; groupId = nil; groupControl = nil; groupDetail = .null; sessionId = nil; detail = .null; assistantDetail = .null
        contentGeneration = UUID(); PreviewFiles.clear(); startEvents()
        await refreshPersonal()
    }
    func openGroup(_ id: String) async {
        guard supportsGroups, id.range(of: "^grp_[a-f0-9-]{36}$", options: .regularExpression) != nil else { return }
        area = .personal; assistantId = nil; groupId = id; groupControl = nil; sessionId = nil
        groupDetail = .null; detail = .null; assistantDetail = .null; contentGeneration = UUID(); PreviewFiles.clear(); startEvents()
        await refreshPersonal()
    }
    func sendGroup(text: String, assistantIds: [String]) async -> Bool {
        guard let groupId, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 16000 else { return false }
        var fields: [String: NativeJSON] = ["prompt": .string(text)]
        if !assistantIds.isEmpty { fields["assistantIds"] = .array(assistantIds.map(NativeJSON.string)) }
        return await mutate(.post, path: "/link/api/personal/groups/" + groupId + "/messages", fields: fields)
    }
    func stopGroup() async {
        guard let workspace, let control = groupControl, control.groupId == groupId, !busy else { return }
        let current = generation, path = "/link/api/personal/groups/" + control.groupId + "/cancel"
        busy = true; defer { if generation == current { busy = false } }
        do {
            var fields: [String: NativeJSON] = ["requestId": .string(UUID().uuidString), "turnId": .string(control.turnId)]
            if let previous = try await workspace.pendingControl() {
                guard previous["path"].string == path, previous["fields"]["turnId"].string == control.turnId else { throw NativeFailure.resultUnknown }
                fields = previous["fields"].object
            }
            let value = try await workspace.freeAction(path: path, fields: fields)
            guard generation == current, groupControl?.turnId == control.turnId else { return }
            groupControl?.state = value["state"].string ?? control.state
            await refreshControlPending()
            if verifiedUntil != nil { await refreshPersonal() }
        } catch { if generation == current { await refreshControlPending(); report(error) } }
    }
    func refreshPersonal() async {
        guard let workspace, connected, supportsPersonal, !verifying else { return }
        let current = generation, selected = assistantId, selectedGroup = groupId, reading = contentGeneration, load = UUID()
        personalLoadId = load; personalLoading = true
        defer { if personalLoadId == load { personalLoading = false; personalLoadId = nil } }
        do {
            try await ensureVerified()
            guard generation == current, area == .personal, assistantId == selected, groupId == selectedGroup, contentGeneration == reading, personalLoadId == load,
                  let lease = await workspace.lease() else { return }
            let value = try await workspace.read("/link/api/personal", body: true)
            guard generation == current, area == .personal, assistantId == selected, groupId == selectedGroup, contentGeneration == reading, personalLoadId == load else { return }
            try lease.requireValid(); personalOverview = value
            if case .array(let plugins) = value["plugins"] { personalPlugins = plugins; personalPluginsLoaded = true }
            else if hasScope("admin") {
                let plugins = try await workspace.read("/link/api/plugins", body: true)
                guard generation == current, area == .personal, assistantId == selected, groupId == selectedGroup, contentGeneration == reading, personalLoadId == load else { return }
                try lease.requireValid(); personalPlugins = plugins["plugins"].array.filter { $0["enabled"].bool }; personalPluginsLoaded = true
            } else { personalPlugins = []; personalPluginsLoaded = false }
            if let selected {
                let value = try await workspace.read("/link/api/personal/assistants/" + selected, body: true)
                guard generation == current, area == .personal, assistantId == selected, groupId == selectedGroup, contentGeneration == reading, personalLoadId == load else { return }
                try lease.requireValid(); assistantDetail = value
            }
            if let selectedGroup {
                let value = try await workspace.read("/link/api/personal/groups/" + selectedGroup, body: true)
                guard generation == current, area == .personal, groupId == selectedGroup, assistantId == selected, contentGeneration == reading, personalLoadId == load else { return }
                try lease.requireValid(); groupDetail = value
                if let turnId = value["turn"]["id"].string, let state = value["turn"]["state"].string {
                    groupControl = PhoneGroupControl(groupId: selectedGroup, turnId: turnId, state: state)
                } else { groupControl = nil }
            }
        } catch { if generation == current, area == .personal, assistantId == selected, groupId == selectedGroup, contentGeneration == reading, personalLoadId == load { report(error) } }
    }
}

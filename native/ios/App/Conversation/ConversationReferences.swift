import Foundation
import LatchNativeCore
import SwiftUI

struct ConversationReferenceSources: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let target: String
    @State private var query = ""
    @State private var choosing = false
    @State private var requests: [String: String] = [:]
    @State private var authorized: [NativeJSON] = []

    private func isPrivate(_ task: NativeJSON) -> Bool {
        task["personal"] != .null || task["agent"] != .null || task["agentPrivate"].bool
    }
    private var valid: Bool {
        model.hasContentWindow && model.transportReady && model.canRun && model.sessionId == target && model.detail["canReferenceConversation"].bool
    }

    var body: some View {
        NavigationStack {
            List {
                if valid {
                    if !authorized.isEmpty {
                        DisclosureGroup("这台设备已授权的引用") {
                            ForEach(Array(authorized.enumerated()), id: \.offset) { _, item in
                                if let ref = item["reference"].string {
                                    HStack {
                                        Text(PhoneConversation.visible(item["source"].string.flatMap { model.summary(of: $0)["title"].string } ?? "会话"))
                                        Spacer()
                                        Button("撤销", role: .destructive) {
                                            Task {
                                                do {
                                                    let request = try NativePendingWrite(method: .delete, path: "/link/api/tasks/\(target)/conversation-references", fields: ["reference": .string(ref)])
                                                    if await model.submit(request) { authorized.removeAll { $0["reference"].string == ref } }
                                                } catch { model.report(error) }
                                            }
                                        }.disabled(model.busy)
                                    }
                                }
                            }
                        }
                    }
                    Section {
                        ForEach(Array(model.snapshot["tasks"].array.filter { item in
                            item["id"].string != target && (!isPrivate(item) || isPrivate(model.currentSummary)) &&
                                (query.isEmpty || (item["title"].string ?? "").localizedCaseInsensitiveContains(query))
                        }.enumerated()), id: \.offset) { _, source in
                            Button(PhoneConversation.visible(source["title"].string ?? "未命名会话")) {
                                guard !choosing, valid, let id = source["id"].string else { return }
                                let rid = requests[id] ?? UUID().uuidString
                                requests[id] = rid
                                choosing = true
                                Task {
                                    defer { choosing = false }
                                    do {
                                        let request = try NativePendingWrite(method: .post, path: "/link/api/tasks/\(target)/conversation-references",
                                            fields: ["source": .string(id)], requestId: rid)
                                        if await model.submit(request) { dismiss() }
                                    } catch { model.report(error) }
                                }
                            }.disabled(choosing)
                        }
                    } footer: { Text("发送后，Agent 可以按需读取所选会话最近 128 条已有消息的文字。") }
                }
            }
            .navigationTitle("引用另一条会话")
            .searchable(text: $query, prompt: "搜索会话标题")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .task(id: target) {
                guard valid, let workspace = model.workspace else { return }
                let host = model.generation, reading = model.contentGeneration
                do {
                    let value = try await workspace.read("/link/api/tasks/\(target)/conversation-references", body: true)
                    if !Task.isCancelled, valid, model.generation == host, model.contentGeneration == reading { authorized = value["references"].array }
                } catch {
                    if !Task.isCancelled, valid, model.generation == host, model.contentGeneration == reading { model.report(error) }
                }
            }
            .onChange(of: valid) { _, valid in if !valid { dismiss() } }
        }
    }
}

struct ReplyCitation: Sendable {
    let insert: @MainActor @Sendable (String, String, Int) -> Void
}
extension EnvironmentValues {
    @Entry var replyCitation: ReplyCitation? = nil
}

struct OriginalReplyPassage: View {
    @EnvironmentObject private var model: PhoneModel
    @Environment(\.dismiss) private var dismiss
    let quote: PhoneReplyQuote
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    if model.hasContentWindow, model.sessionId == quote.session,
                       let message = model.detail["messages"].array.first(where: { $0["id"].string == quote.message && $0["role"].string == "assistant" }),
                       let text = message["text"].string {
                        VStack(alignment: .leading, spacing: 8) {
                            if let original = quote.original(in: text) {
                                let ns = original.text as NSString
                                ConversationText(text: ns.substring(to: original.range.location))
                                Text(quote.text).font(PhoneTheme.body).padding(8).background(PhoneTheme.bubble).id("passage")
                                ConversationText(text: ns.substring(from: NSMaxRange(original.range)))
                            } else { ConversationText(text: text) }
                        }.padding().task { proxy.scrollTo("passage", anchor: .center) }
                    }
                }
            }
            .navigationTitle("引用原文")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }
    }
}

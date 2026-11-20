import LatchNativeCore
import SwiftUI

struct SessionFilesContext: Hashable {
    let session: String
    let host: UUID
    let selection: UUID
    let window: UUID
    let transport: NativeTransportEpoch?
    let tree: Bool
    let search: Bool
    var browse: Bool { tree || search }
}

extension PhoneModel {
    func filesContext(_ session: String) -> SessionFilesContext {
        let current = connected && hasContentWindow && sessionId == session
        return SessionFilesContext(session: session, host: generation, selection: contentGeneration, window: privateSnapshot.epoch,
            transport: installedTransport, tree: current && PhoneFileDirectory.offered(snapshot, session: session),
            search: current && PhoneFileDirectory.offered(snapshot, session: session, feature: .search))
    }

    func findFiles(_ query: String, in context: SessionFilesContext) async throws -> PhoneFileMatches {
        guard context.search, filesContext(context.session) == context else { throw NativeFailure.contextChanged }
        #if LATCH_SCREENS
        if staged { return try ScreensStage.fileMatches(query) }
        #endif
        guard let workspace, let access = currentFileAccess, access.transport === context.transport else { throw NativeFailure.unavailable }
        let result = try await workspace.findProjectFiles(session: context.session, query: query, access: access)
        try Task.checkCancellation()
        guard filesContext(context.session) == context else { throw NativeFailure.contextChanged }
        return result
    }

    func directory(_ folder: PhoneFileFolder, in context: SessionFilesContext) async throws -> PhoneFileDirectory {
        guard context.tree, filesContext(context.session) == context else { throw NativeFailure.contextChanged }
        #if LATCH_SCREENS
        if staged { return try ScreensStage.fileDirectory(session: context.session, folder: folder) }
        #endif
        guard let workspace, let access = currentFileAccess, access.transport === context.transport else { throw NativeFailure.unavailable }
        let result = try await workspace.fileDirectory(session: context.session, folder: folder, access: access)
        try Task.checkCancellation()
        guard filesContext(context.session) == context else { throw NativeFailure.contextChanged }
        return result
    }
}

private struct FolderLink: Hashable {
    let folder: PhoneFileFolder
    let title: String
}

struct SessionFilesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let context: SessionFilesContext
    let files: [PhoneChangedFile]
    let open: (String, String?) -> Void

    var body: some View {
        NavigationStack {
            SessionFilePage(folder: PhoneFileFolder(), context: context, files: files, open: open)
                .navigationTitle("文件")
                .navigationDestination(for: FolderLink.self) { link in
                    SessionFilePage(folder: link.folder, context: context, files: [], open: open)
                        .id(link.folder).navigationTitle(link.title)
                }
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .listStyle(.plain)
        .presentationDetents([.large])
    }
}

private struct SessionFilePage: View {
    @EnvironmentObject private var model: PhoneModel
    let folder: PhoneFileFolder
    let context: SessionFilesContext
    let files: [PhoneChangedFile]
    let open: (String, String?) -> Void
    @State private var search = ""
    @State private var retry = 0
    @State private var loaded: (request: Request, content: Content)?

    private enum Content { case directory(PhoneFileDirectory), matches(PhoneFileMatches), failed(String) }
    private struct Request: Equatable { let query: Data; let retry: Int }
    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        let query = self.query
        let request = Request(query: Data(query.utf8), retry: retry)
        List {
            if folder.root == nil && context.search {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    LocalSearchInput(query: $search, prompt: "按文件名搜索项目", identifier: "files.search")
                }
            }
            if query.utf16.count > 512 { Text("请缩短搜索词").foregroundStyle(.secondary) }
            else if !query.isEmpty || context.tree {
                Section {
                    if let loaded, loaded.request == request {
                        switch loaded.content {
                        case let .directory(page): directoryRows(page)
                        case let .matches(found): searchRows(found)
                        case let .failed(message):
                            Text(message).foregroundStyle(.secondary)
                            Button("重试") { retry += 1 }
                        }
                    } else { ProgressView(query.isEmpty ? "正在读取文件夹…" : "正在搜索…") }
                } header: { if folder.root == nil && query.isEmpty { Text("项目文件夹") } }
            }
            if query.isEmpty && !files.isEmpty {
                Section {
                    ForEach(files) { file in Button { open(file.path, file.root) } label: { FileRowLabel(file: file) } }
                } header: { if context.browse { Text("会话中的文件") } }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        // Keep the request on the list. Replacing its loading row or scrolling a result into view must not restart it.
        .task(id: request) {
            guard loaded?.request != request, query.utf16.count <= 512, !query.isEmpty || context.tree else { return }
            do {
                let content: Content
                if query.isEmpty { content = .directory(try await model.directory(folder, in: context)) }
                else {
                    try await Task.sleep(for: .milliseconds(300))
                    content = .matches(try await model.findFiles(query, in: context))
                }
                try Task.checkCancellation()
                loaded = (request, content)
            } catch {
                guard !Task.isCancelled else { return }
                let message = (error as? NativeFailure)?.errorDescription ?? (query.isEmpty ? "暂时无法读取此文件夹" : "暂时无法搜索文件")
                loaded = (request, .failed(message))
            }
        }
    }

    @ViewBuilder private func directoryRows(_ page: PhoneFileDirectory) -> some View {
        if folder.root == nil {
            ForEach(page.roots) { root in
                let title = PhoneConversation.visible(root.name.isEmpty ? root.id : root.name)
                NavigationLink(value: FolderLink(folder: PhoneFileFolder(root: root.id), title: title)) {
                    Label(title, systemImage: "folder")
                }
            }
            if page.roots.isEmpty { Text("此会话没有可浏览的项目文件夹").foregroundStyle(.secondary) }
        } else {
            ForEach(page.entries) { entry in entryRow(entry) }
            if page.truncated { Text("文件较多，仅显示部分内容").foregroundStyle(.secondary) }
            else if page.entries.isEmpty { Text("此文件夹没有可显示的文件").foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder private func entryRow(_ entry: PhoneFileDirectory.Entry) -> some View {
        let name = PhoneConversation.visible(entry.name)
        let path = folder.appending(entry.name)
        switch entry.kind {
        case .directory:
            NavigationLink(value: FolderLink(folder: PhoneFileFolder(root: folder.root, dir: path), title: name)) { Label(name, systemImage: "folder") }
        case .file:
            Button { open(path, folder.root) } label: { Label(name, systemImage: "doc") }
        case .symlink, .other:
            LabeledContent {
                Text(entry.kind == .symlink ? "符号链接" : "不可预览")
            } label: { Label(name, systemImage: entry.kind == .symlink ? "link" : "doc") }.foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func searchRows(_ result: PhoneFileMatches) -> some View {
        ForEach(result.files) { hit in
            Button { open(hit.path, hit.root) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(PhoneConversation.visible(hit.name))
                    Text(PhoneConversation.visible(hit.root + " · " + hit.path)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        if result.truncated { Text("仅显示部分结果，请缩小范围").foregroundStyle(.secondary) }
        if result.uncheckedCount > 0 {
            Text("有 \(result.uncheckedCount) 项未能核对忽略规则，已跳过").foregroundStyle(.secondary)
        } else if !result.truncated && result.files.isEmpty { Text("没有匹配的文件").foregroundStyle(.secondary) }
    }
}

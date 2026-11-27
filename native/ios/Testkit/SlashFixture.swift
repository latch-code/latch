import Foundation
import LatchNativeCore

func phoneSlashFixture(_ input: Data) throws -> [String: Any] {
    // JSONSerialization drops a leading U+FEFF inside a string; the product's bounded JSONDecoder retains it.
    let vectors = try NativeJSON.decode(input)
    let cases: [[String: Any]] = vectors["cases"].array.map { item in
        let value = PhoneSlash.match(item["name"].string ?? "", query: item["query"].string ?? "", description: item["description"].string ?? "")
        return ["score": value.map { $0.score as Any } ?? NSNull(), "positions": value.map { $0.positions as Any } ?? NSNull()]
    }
    let tokens: [Any] = vectors["tokens"].array.map { item in
        guard let token = PhoneSlash.token(item["draft"].string ?? "", caret: item["caret"].integer.map(Int.init)) else { return NSNull() }
        return ["query": token.query, "start": token.start, "end": token.end, "initial": token.initial] as [String: Any]
    }
    let actions: [Any] = vectors["actions"].array.map { item in
        guard let action = PhoneSlash.actionOf(item["draft"].string ?? "") else { return NSNull() }
        return ["name": action.action.rawValue, "argument": action.argument]
    }
    var context = PhoneSlashContext(bodyOpen: true, canRun: true)
    context.harnessId = "native-fixture"; context.projectId = "project-a"; context.session = true
    let commands = (0..<200).map { NativeJSON.object(["name": .string("command\($0)")]) }
    let all = PhoneSlash.menu("/", commands: commands, templates: [], context: context)!
    let commandRows = all.options.filter { $0.kind == .command && $0.unavailable == nil }
    guard commandRows.count == 200, commandRows.last?.label == "/command199", all.initialSelection == nil,
          all.moved(from: nil, down: true) == 0, all.moved(from: nil, down: false) == 199, all.moved(from: 199, down: true) == 0 else { throw NativeFailure.invalidRecord }
    let raw: [NativeJSON] = [.object(["name": .string("clear")]), .object(["name": .string("MODEL")]), .object(["name": .string("init"), "description": .string("A\u{202E}B")])]
    let reserved = PhoneSlash.menu("/", commands: raw, templates: [], context: context)!
    guard reserved.options.filter({ $0.kind == .command && $0.unavailable == nil }).map(\.label) == ["/init"],
          reserved.options.first?.description == "A\\u{202E}B" else { throw NativeFailure.invalidRecord }
    for action in PhoneSlashAction.allCases {
        guard case .unavailable = PhoneSlash.action("/" + action.rawValue, context: context) else { throw NativeFailure.invalidRecord }
    }
    context.actions = [.model]
    guard case let .open(action, argument) = PhoneSlash.action("／MODEL fixture", context: context), action == .model, argument == "fixture" else { throw NativeFailure.invalidRecord }
    let templates: [NativeJSON] = [
        .object(["id": .string("review"), "name": .string("代码审查"), "content": .string("检查 $ARGUMENTS"), "scope": .object(["kind": .string("all")])]),
        .object(["id": .string("project"), "name": .string("Project"), "content": .string("Project body"), "scope": .object(["kind": .string("project"), "id": .string("project-a")])]),
        .object(["id": .string("harness"), "name": .string("Harness"), "content": .string("Harness body"), "scope": .object(["kind": .string("agent"), "id": .string("native-fixture")])]),
        .object(["id": .string("other"), "name": .string("Other"), "content": .string("Other body"), "scope": .object(["kind": .string("project"), "id": .string("project-b")])]),
    ]
    let scoped = PhoneSlash.menu("/", commands: [], templates: templates, context: context)!
    guard scoped.options.filter({ $0.kind == .template }).count == 3 else { throw NativeFailure.invalidRecord }
    let draft = "🙂 /rev 后缀", menu = PhoneSlash.menu(draft, caret: 7, commands: commands, templates: templates, context: context)!
    guard menu.options.count == 1, menu.options[0].kind == .template,
          let edit = PhoneSlash.complete(menu, optionId: menu.options[0].id, draft: draft, caret: 7, enabled: true),
          edit.text == "🙂 检查 $ARGUMENTS 后缀", edit.selectionStart == 6, edit.selectionEnd == 16,
          PhoneSlash.complete(menu, optionId: menu.options[0].id, draft: draft + "changed", caret: 7, enabled: true) == nil,
          PhoneSlash.complete(menu, optionId: menu.options[0].id, draft: draft, caret: 7, enabled: false) == nil else { throw NativeFailure.invalidRecord }
    func opens(_ draft: String, _ location: Int, _ length: Int = 0, as expected: String, at caret: Int) -> Bool {
        guard let first = PhoneSlash.openSuggestions(draft, selection: NSRange(location: location, length: length)),
              first.text == expected, first.selectionStart == caret, first.selectionEnd == caret,
              PhoneSlash.token(first.text, caret: caret) != nil,
              let again = PhoneSlash.openSuggestions(first.text, selection: NSRange(location: caret, length: 0)) else { return false }
        return again.text == first.text && again.selectionStart == caret && again.selectionEnd == caret
    }
    guard opens("", 0, as: "/", at: 1),
          opens("/", 1, as: "/", at: 1),
          opens("／模型 后缀", 1, as: "／模型 后缀", at: 3),
          opens("🙂 /rev 后缀", 5, as: "🙂 /rev 后缀", at: 7),
          opens("前🙂后", 1, 2, as: "前 / 后", at: 3),
          opens("草稿正文", 2, as: "草稿 / 正文", at: 4),
          opens("草稿", 2, as: "草稿 /", at: 4),
          PhoneSlash.openSuggestions("🙂", selection: NSRange(location: 1, length: 0)) == nil,
          PhoneSlash.openSuggestions("/", selection: NSRange(location: NSNotFound, length: 0)) == nil,
          PhoneSlash.menu("正文 /", commands: commands, templates: [], context: context)?.sections == [],
          PhoneSlash.menu("正文 /", commands: commands, templates: templates, context: context)?.sections == [.template],
          all.sections == [.command, .action]
    else { throw NativeFailure.invalidRecord }
    let native: [NativeJSON] = [.object(["name": .string("compact"), "idleOnly": .bool(true)]), .object(["name": .string("status")])]
    var unsupported = PhoneSlashContext(bodyOpen: true, canRun: true, harness: .object(["extensionSupport": .object(["reports": .array([])])]))
    unsupported.session = true
    let draftContext = PhoneSlashContext(bodyOpen: true, canRun: true)
    var readingDraft = draftContext; readingDraft.readingCommands = true
    var previousDraft = draftContext; previousDraft.commandSource = "previous-session"
    var harnessDraft = draftContext; harnessDraft.commandSource = "harness"
    guard PhoneSlash.menu("/", commands: nil, templates: [], context: draftContext)?.commandNotice == "发送第一条消息后，可查看 Harness 返回的命令",
          PhoneSlash.menu("/", commands: nil, templates: [], context: readingDraft)?.commandNotice == "正在读取命令列表…",
          PhoneSlash.menu("/", commands: [], templates: [], context: previousDraft)?.commandNotice == "上次会话没有列出命令",
          PhoneSlash.menu("/", commands: [], templates: [], context: harnessDraft)?.commandNotice == "当前 Harness 没有列出命令",
          PhoneSlash.menu("/", commands: nil, templates: [], context: context)?.commandNotice == "当前连接尚未提供命令列表",
          PhoneSlash.menu("/", commands: [], templates: [], context: context)?.commandNotice == "当前会话没有可用的 Harness 命令",
          PhoneSlash.menu("/", commands: nil, templates: [], context: unsupported)?.commandNotice == "当前接入方式不提供 Harness 命令",
          PhoneSlash.menu("/", commands: native, templates: [], context: unsupported)?.options.first?.label == "/compact",
          PhoneSlash.menu("/", commands: native, templates: [], context: unsupported)?.commandNotice == nil,
          PhoneSlash.menu("/", commands: [], templates: [], context: context)?.options.contains(where: { $0.label == "/compact" }) == false,
          PhoneSlash.menu("/compact", commands: [], templates: [], context: context)?.options.first?.unavailable == "这个 Harness 尚不支持",
          PhoneSlash.menu("/compact", commands: nil, templates: [], context: context)?.options.contains(where: { $0.label == "/compact" }) == false
    else { throw NativeFailure.invalidRecord }
    context.running = true
    let running = PhoneSlash.menu("/", commands: native, templates: [], context: context)!
    guard running.options[0].label == "/status", running.options[1].label == "/compact",
          running.options[1].unavailable == "这一轮结束后可用" else { throw NativeFailure.invalidRecord }
    context.running = false; context.firstTurn = true
    guard PhoneSlash.menu("/compact", commands: native, templates: [], context: context)?.options.first?.unavailable == "第一条消息之后可用" else { throw NativeFailure.invalidRecord }
    context.firstTurn = false; context.pending = true
    guard PhoneSlash.menu("/", commands: native, templates: templates, context: context)?.options.allSatisfy({ $0.unavailable != nil }) == true,
          case .unavailable = PhoneSlash.action("/model", context: context) else { throw NativeFailure.invalidRecord }
    context.pending = false; context.canRun = false
    guard case .unavailable = PhoneSlash.action("/model", context: context) else { throw NativeFailure.invalidRecord }
    context.bodyOpen = false
    guard PhoneSlash.menu("/", commands: commands, templates: templates, context: context) == nil,
          case .unavailable = PhoneSlash.action("/model", context: context) else { throw NativeFailure.invalidRecord }
    return ["initials": vectors["initials"].array.map { PhoneSlash.pinyinInitials($0["name"].string ?? "") },
        "cases": cases, "tokens": tokens, "actions": actions, "all200Reachable": true,
        "reservedNames": true, "scopeFiltering": true, "editableInsertion": true, "utf16Selection": true,
        "staleInsertionRefused": true, "runningFirstTurn": true, "closedPendingReadOnly": true]
}

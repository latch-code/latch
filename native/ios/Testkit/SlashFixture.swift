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
    let native: [NativeJSON] = [.object(["name": .string("compact"), "idleOnly": .bool(true)]), .object(["name": .string("status")])]
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
    return ["cases": cases, "tokens": tokens, "actions": actions, "all200Reachable": true,
        "reservedNames": true, "scopeFiltering": true, "editableInsertion": true, "utf16Selection": true,
        "staleInsertionRefused": true, "runningFirstTurn": true, "closedPendingReadOnly": true]
}

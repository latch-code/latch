import Foundation

public struct PhoneSlashMatch: Sendable, Equatable {
    public let score: Int
    /** UTF-16 offsets, as in the web editor and UITextView's selectedRange. */
    public let positions: [Int]
}
public struct PhoneSlashToken: Sendable {
    public let query: String
    public let start: Int
    public let end: Int
    public let initial: Bool
}
public enum PhoneSlashAction: String, CaseIterable, Sendable {
    case clear, btw, fork, new, model, think, permissions, changes
    public var label: String {
        switch self {
        case .clear: "清空上下文"
        case .btw: "旁支提问"
        case .fork: "从最新一轮分叉"
        case .new: "新会话"
        case .model: "选择模型"
        case .think: "选择思考深度"
        case .permissions: "选择权限"
        case .changes: "打开改动"
        }
    }
    public var inputHint: String? {
        switch self {
        case .btw: "问题"
        case .fork, .new: "第一句（可选）"
        case .model: "筛选（可选）"
        default: nil
        }
    }
}

/** UI facts only, never an authorization grant. The App supplies only handlers its current page already owns. */
public struct PhoneSlashContext: Sendable {
    public var bodyOpen: Bool
    public var canRun: Bool
    public var pending = false
    public var running = false
    public var firstTurn = false
    public var session = false
    public var projectId: String?
    public var harnessId: String?
    public var actions: Set<PhoneSlashAction> = []
    public var actionReasons: [PhoneSlashAction: String] = [:]
    public init(bodyOpen: Bool, canRun: Bool) { self.bodyOpen = bodyOpen; self.canRun = canRun }
    fileprivate var blocked: String? { pending ? "先核对待确认的提交" : !canRun ? "这台设备不能开始会话" : nil }
}

public struct PhoneSlashOption: Sendable, Identifiable {
    public enum Kind: Int, Sendable { case command, template, action }
    public let id: String
    public let kind: Kind
    public let label: String
    public let description: String
    public let inputHint: String?
    public let unavailable: String?
    public let score: Int
    public let positions: [Int]
    fileprivate let text: String
}
public struct PhoneSlashMenu: Sendable {
    public let token: PhoneSlashToken
    public let options: [PhoneSlashOption]
    fileprivate let draft: String
    fileprivate let caret: Int
    public var initialSelection: Int? { token.query.isEmpty ? nil : options.firstIndex { $0.unavailable == nil } }
    public func moved(from current: Int?, down: Bool) -> Int? {
        let usable = options.indices.filter { options[$0].unavailable == nil }
        guard !usable.isEmpty else { return nil }
        guard let current, let index = usable.firstIndex(of: current) else { return down ? usable.first : usable.last }
        return usable[(index + (down ? 1 : usable.count - 1)) % usable.count]
    }
}
public struct PhoneSlashEdit: Sendable {
    public let text: String
    public let selectionStart: Int
    public let selectionEnd: Int
}
public enum PhoneSlashActionResult: Sendable {
    case text, open(PhoneSlashAction, argument: String), unavailable(String)
}

/** Stateless matching and editable completion. There is no network, storage or send operation here. */
public enum PhoneSlash {
    private static func equal(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b else { return false }; return a.utf8.elementsEqual(b.utf8)
    }
    // ECMAScript whitespace, rather than Foundation's wider set (which also contains U+0085).
    private static func space(_ unit: UInt16) -> Bool {
        [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279].contains(unit) || (8192...8202).contains(unit)
    }
    private static func trim(_ text: String) -> String {
        let units = Array(text.utf16), start = units.firstIndex { !space($0) } ?? units.count
        let end = units.lastIndex { !space($0) }.map { $0 + 1 } ?? start
        return String(decoding: units[start..<end], as: UTF16.self)
    }
    private static func boundary(_ units: [UInt16], _ index: Int) -> Bool {
        index >= 0 && index <= units.count && (index == 0 || index == units.count || !((0xD800...0xDBFF).contains(units[index - 1]) && (0xDC00...0xDFFF).contains(units[index])))
    }
    private static func find(_ value: [UInt16], _ needle: [UInt16], from: Int = 0) -> Int? {
        guard !needle.isEmpty, from >= 0, value.count >= needle.count, from <= value.count - needle.count else { return nil }
        return (from...(value.count - needle.count)).first { value[$0..<($0 + needle.count)].elementsEqual(needle) }
    }
    public static func pinyinInitials(_ text: String) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            let letter = String(scalar)
            if letter.range(of: "\\p{Unified_Ideograph}", options: .regularExpression) != nil,
               let latin = letter.applyingTransform(.mandarinToLatin, reverse: false)?.applyingTransform(.stripDiacritics, reverse: false)?.lowercased(),
               let first = latin.utf8.first, (97...122).contains(first) { result += String(UnicodeScalar(first)) }
            else { result += letter.lowercased() }
        }
        return result
    }
    public static func match(_ name: String, query: String, description: String = "") -> PhoneSlashMatch? {
        let value = Array(name.lowercased().utf16), needle = Array(query.lowercased().utf16)
        func hit(_ score: Int, _ start: Int = 0, _ count: Int = 0) -> PhoneSlashMatch { PhoneSlashMatch(score: score, positions: Array(start..<(start + count))) }
        if needle.isEmpty { return hit(0) }
        if value == needle { return hit(0, 0, needle.count) }
        if value.starts(with: needle) { return hit(1, 0, needle.count) }
        let separators: Set<UInt16> = [45, 95, 58, 47, 46]
        for index in value.indices where index == 0 || space(value[index - 1]) || separators.contains(value[index - 1]) {
            if !space(value[index]), !separators.contains(value[index]), value[index...].starts(with: needle) { return hit(2, index, needle.count) }
        }
        if needle.allSatisfy({ (97...122).contains($0) }), name.range(of: "\\p{Unified_Ideograph}", options: .regularExpression) != nil,
           Array(pinyinInitials(name).utf16).starts(with: needle) { return hit(3) }
        if let index = find(value, needle) { return hit(4, index, needle.count) }
        var positions: [Int] = [], from = 0
        for scalar in query.lowercased().unicodeScalars {
            let units = Array(String(scalar).utf16)
            guard let index = find(value, units, from: from) else { break }
            positions += index..<(index + units.count); from = index + units.count
        }
        if positions.count == needle.count { return PhoneSlashMatch(score: 5, positions: positions) }
        if find(Array(description.lowercased().utf16), needle) != nil { return hit(6) }
        return nil
    }
    public static func token(_ draft: String, caret: Int? = nil) -> PhoneSlashToken? {
        let units = Array(draft.utf16), end = caret ?? units.count
        guard boundary(units, end), end == units.count || space(units[end]) else { return nil }
        var start = end
        while start > 0, !space(units[start - 1]) { start -= 1 }
        guard start < end, [47, 65295].contains(units[start]), !units[(start + 1)..<end].contains(where: { [47, 65295].contains($0) }) else { return nil }
        return PhoneSlashToken(query: String(decoding: units[(start + 1)..<end], as: UTF16.self).lowercased(), start: start, end: end, initial: start == 0)
    }
    public static func actionOf(_ draft: String) -> (action: PhoneSlashAction, argument: String)? {
        let units = Array(trim(draft).utf16)
        guard let first = units.first, [47, 65295].contains(first) else { return nil }
        let end = units.dropFirst().firstIndex(where: space) ?? units.count
        let name = String(decoding: units[1..<end], as: UTF16.self).lowercased()
        guard let action = PhoneSlashAction(rawValue: name) else { return nil }
        return (action, trim(String(decoding: units[end...], as: UTF16.self)))
    }
    public static func action(_ draft: String, context: PhoneSlashContext) -> PhoneSlashActionResult {
        guard let requested = actionOf(draft) else { return .text }
        if let reason = unavailable(requested.action, context: context) { return .unavailable(reason) }
        return .open(requested.action, argument: requested.argument)
    }
    private static func unavailable(_ action: PhoneSlashAction, context: PhoneSlashContext) -> String? {
        if !context.bodyOpen { return "查看内容后可以使用命令" }
        if let reason = context.blocked { return reason }
        if context.running, action == .clear || action == .fork { return "这一轮结束后可用" }
        if let reason = context.actionReasons[action] { return reason }
        return context.actions.contains(action) ? nil : "iPhone 尚未实现"
    }
    public static func menu(_ draft: String, caret: Int? = nil, commands: [NativeJSON], templates: [NativeJSON], context: PhoneSlashContext) -> PhoneSlashMenu? {
        guard context.bodyOpen, let token = token(draft, caret: caret), commands.count <= 200, templates.count <= 200 else { return nil }
        var options: [PhoneSlashOption] = [], seen = Set<String>()
        func add(_ kind: PhoneSlashOption.Kind, id: String, label: String, description: String, text: String,
            matched: PhoneSlashMatch?, hint: String? = nil, reason: String? = nil) {
            guard let matched else { return }
            let key = "\(kind.rawValue):" + LinkBytes.base64url(Data(id.utf8))
            guard seen.insert(key).inserted else { return }
            let safe = PhoneConversation.visible(label), offset = safe.hasPrefix("/") ? 1 : 0
            let highlighted = match(offset == 1 ? String(safe.dropFirst()) : safe, query: token.query)?.positions.map { $0 + offset } ?? []
            options.append(PhoneSlashOption(id: key, kind: kind, label: safe,
                description: PhoneConversation.visible(context.blocked ?? reason ?? description), inputHint: hint.map(PhoneConversation.visible),
                unavailable: context.blocked ?? reason, score: matched.score, positions: highlighted, text: text))
        }
        if token.initial {
            for command in commands {
                guard let name = command["name"].string, !name.isEmpty, name.utf16.count <= 100,
                      name.unicodeScalars.allSatisfy({ !space(UInt16(clamping: $0.value)) && ![.control, .format].contains($0.properties.generalCategory) }),
                      actionOf("/" + name) == nil else { continue }
                let description = command["description"].string ?? "", hint = command["inputHint"].string
                guard description.utf16.count <= 1000, (hint?.utf16.count ?? 0) <= 500 else { continue }
                let reason = context.firstTurn ? "第一条消息之后可用" : context.running && command["idleOnly"].bool ? "这一轮结束后可用" : nil
                add(.command, id: name, label: "/" + name, description: description, text: "/" + name + " ",
                    matched: match(name, query: token.query, description: description), hint: hint, reason: reason)
            }
        }
        for template in templates {
            guard let id = template["id"].string, !id.isEmpty, id.utf16.count <= 128,
                  let name = template["name"].string, !name.isEmpty, name.utf16.count <= 80,
                  let content = template["content"].string, content.utf16.count <= 20_000 else { continue }
            let scope = template["scope"], kind = scope["kind"].string
            guard kind == "all" || kind == "project" && equal(scope["id"].string, context.projectId)
                || kind == "agent" && equal(scope["id"].string, context.harnessId) else { continue }
            let description = content.components(separatedBy: "\n").first { !trim($0).isEmpty } ?? ""
            let random = LinkBytes.matches(id, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
            let matches = [match(name, query: token.query, description: description), random ? nil : match(id, query: token.query, description: description)].compactMap { $0 }
            add(.template, id: id, label: random ? "/" + name : "/" + id + " · " + name, description: description, text: content,
                matched: matches.min { $0.score < $1.score })
        }
        if token.initial {
            for action in PhoneSlashAction.allCases {
                if action == .clear && !context.session || action == .changes && context.projectId == nil { continue }
                let reason = unavailable(action, context: context)
                let matched = match(action.rawValue, query: token.query, description: action.label)
                    ?? (match(action.label, query: token.query)?.score == 3 ? PhoneSlashMatch(score: 6, positions: []) : nil)
                add(.action, id: action.rawValue, label: "/" + action.rawValue, description: action.label, text: "/" + action.rawValue + " ",
                    matched: matched, hint: action.inputHint, reason: reason)
            }
            if context.session, !commands.contains(where: { equal($0["name"].string, "compact") }) {
                add(.command, id: "compact", label: "/compact", description: "压缩上下文", text: "/compact ",
                    matched: match("compact", query: token.query, description: "压缩上下文"), reason: "这个 Harness 尚不支持")
            }
        }
        let sorted = options.enumerated().sorted { left, right in
            let a = left.element, b = right.element
            if !token.query.isEmpty {
                if (a.unavailable == nil) != (b.unavailable == nil) { return a.unavailable == nil }
                if a.score != b.score { return a.score < b.score }
            }
            if a.kind.rawValue != b.kind.rawValue { return a.kind.rawValue < b.kind.rawValue }
            if (a.unavailable == nil) != (b.unavailable == nil) { return a.unavailable == nil }
            return left.offset < right.offset
        }.map(\.element)
        return PhoneSlashMenu(token: token, options: sorted, draft: draft, caret: caret ?? draft.utf16.count)
    }
    /** A tap/Tab only edits visible text. The sender separately intercepts all eight reserved names. */
    public static func complete(_ menu: PhoneSlashMenu, optionId: String, draft: String, caret: Int, enabled: Bool) -> PhoneSlashEdit? {
        guard enabled, equal(menu.draft, draft), menu.caret == caret,
              let option = menu.options.first(where: { $0.id == optionId }), option.unavailable == nil else { return nil }
        let units = Array(draft.utf16), token = menu.token
        let text = String(decoding: units[..<token.start], as: UTF16.self) + option.text + String(decoding: units[token.end...], as: UTF16.self)
        let placeholder = option.kind == .template ? find(Array(option.text.utf16), Array("$ARGUMENTS".utf16)) : nil
        let start = token.start + (placeholder ?? option.text.utf16.count)
        return PhoneSlashEdit(text: text, selectionStart: start, selectionEnd: start + (placeholder == nil ? 0 : 10))
    }
}

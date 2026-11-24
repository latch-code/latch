import CryptoKit
import Foundation
import LocalAuthentication
import Security

/** This non-migrating App Group key protects only the public approval preview rendered by the widget. */
enum ApprovalSessionPreview {
    struct Details: Decodable {
        let title: String
        let fileName: String?
    }

    private static func query(route: String) -> [CFString: Any]? {
        guard UUID(uuidString: route) != nil,
              let group = Bundle.main.object(forInfoDictionaryKey: "LatchAppGroup") as? String,
              group.hasPrefix("group.") else { return nil }
        return [kSecClass: kSecClassGenericPassword, kSecAttrService: "codes.latch.approval-preview.v1",
                kSecAttrAccount: route, kSecAttrAccessGroup: group, kSecAttrSynchronizable: false]
    }

    static func key(route: String, create: Bool = false) -> Data? {
        guard let query = query(route: route) else { return nil }
        let (status, data) = read(query)
        if status == errSecSuccess { return data }
        guard status == errSecItemNotFound, create else { return nil }

        let generated = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        switch store(generated, query: query) {
        case errSecSuccess: return generated
        case errSecDuplicateItem: return key(route: route)
        default: return nil
        }
    }

    private static func read(_ query: [CFString: Any]) -> (OSStatus, Data?) {
        var read = query
        let context = LAContext()
        context.interactionNotAllowed = true
        read[kSecUseAuthenticationContext] = context
        read[kSecReturnData] = true
        read[kSecMatchLimit] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &value)
        guard status == errSecSuccess, let data = value as? Data, data.count == 32 else { return (status, nil) }
        return (status, data)
    }

    private static func store(_ data: Data, query: [CFString: Any]) -> OSStatus {
        var item = query
        // WidgetKit can first render a push while the screen is locked, after the owner has unlocked once.
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        item[kSecValueData] = data
        return SecItemAdd(item as CFDictionary, nil)
    }

    static func remove(route: String) {
        guard let query = query(route: route) else { return }
        _ = SecItemDelete(query as CFDictionary)
    }

    static func open(_ sealed: String?, attributes: LatchQuestionAttributes) -> Details? {
        guard attributes.approval == true, let route = attributes.route,
              let ticket = attributes.ticket, ticket.count == 32,
              ticket.allSatisfy({ "0123456789abcdef".contains($0) }),
              let sealed, sealed.utf8.count <= 2_048, let bytes = Data(base64Encoded: sealed),
              let box = try? AES.GCM.SealedBox(combined: bytes), let key = key(route: route) else { return nil }
        let context = Data("latch-ios-approval-session:v1\n\(route)\n\(ticket)".utf8)
        return decrypt(box, key: key, context: context)
    }

    #if LATCH_SCREENS && targetEnvironment(simulator)
    static func installFixtureKey(_ data: Data, route: String) -> (write: OSStatus, read: OSStatus) {
        guard data.count == 32, let query = query(route: route) else { return (errSecParam, errSecParam) }
        let saved = store(data, query: query)
        let (loaded, existing) = read(query)
        return (saved == errSecDuplicateItem && existing == data ? errSecSuccess : saved, loaded)
    }
    #endif

    private static func decrypt(_ box: AES.GCM.SealedBox, key: Data, context: Data) -> Details? {
        guard let plaintext = try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: context),
              let details = try? JSONDecoder().decode(Details.self, from: plaintext),
              safe(details.title, limit: 96) else { return nil }
        let name = details.fileName.flatMap { name in
            safe(name, limit: 128) && !name.contains("/") && !name.contains("\\") && name != "." && name != ".." ? name : nil
        }
        return Details(title: details.title, fileName: name)
    }

    private static func safe(_ value: String, limit: Int) -> Bool {
        !value.isEmpty && value.unicodeScalars.count <= limit && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && value.unicodeScalars.allSatisfy { scalar in
                switch scalar.properties.generalCategory {
                case .control, .format, .lineSeparator, .paragraphSeparator, .privateUse, .unassigned: false
                default: true
                }
            }
    }
}

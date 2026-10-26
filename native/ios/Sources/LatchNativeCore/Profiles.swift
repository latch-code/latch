import Foundation

public struct NativeRegisteredHost: Codable, Identifiable, Sendable {
    public var id: String { device.hostId + "-" + device.deviceId }
    public var name: String
    public var device: PreparedNativeDevice
    public var keys: DeviceKeyReference
    public var prepared: Bool
    public init(name: String, device: PreparedNativeDevice, keys: DeviceKeyReference, prepared: Bool) { self.name = name; self.device = device; self.keys = keys; self.prepared = prepared }
}
public struct NativePairingDraft: Codable, Sendable {
    public let payload: String
    public let keys: DeviceKeyReference
    public let name: String
    public init(payload: String, keys: DeviceKeyReference, name: String) { self.payload = payload; self.keys = keys; self.name = name }
}

public actor NativeProfileStore {
    private let root: URL
    private var key: Data?
    private let vault: EncryptedVault
    private var hosts: [NativeRegisteredHost] = []
    private var retirements: [NativeRegisteredHost] = []
    private var profileTail: Task<Void, Never>?
    private var closed = false
    private var children: [String: EncryptedVault] = [:]
    private let eraseKeys: @Sendable (DeviceKeyReference) async throws -> Void
    public static func open(directory: URL, key: Data,
        eraseKeys: @escaping @Sendable (DeviceKeyReference) async throws -> Void = { try SecureDeviceKeys.removeChecked($0) }) async throws -> NativeProfileStore {
        let vault = try EncryptedVault(directory: directory.appendingPathComponent("profiles"), key: key, binding: "profiles")
        let store = NativeProfileStore(root: directory, key: key, vault: vault, eraseKeys: eraseKeys)
        try await store.load(); return store
    }
    private init(root: URL, key: Data, vault: EncryptedVault, eraseKeys: @escaping @Sendable (DeviceKeyReference) async throws -> Void) {
        self.root = root; self.key = key; self.vault = vault; self.eraseKeys = eraseKeys
    }
    private func load() async throws {
        if let data = try await vault.metadata(name: "hosts") {
            let value = try JSONDecoder().decode([NativeRegisteredHost].self, from: data)
            guard !closed, value.count <= 16, Set(value.map(\.id)).count == value.count else { throw NativeFailure.storageUnavailable }
            for host in value { try validate(host) }
            hosts = value
        }
        if let data = try await vault.metadata(name: "retirements") {
            let value = try JSONDecoder().decode([NativeRegisteredHost].self, from: data)
            guard value.count <= 16, Set(value.map(\.id)).count == value.count else { throw NativeFailure.storageUnavailable }
            for host in value { try validate(host) }
            retirements = value
            hosts.removeAll { host in value.contains { $0.id == host.id } }
            // This authenticated record is written only after a verified Root notice. Retry cleanup without reconnecting.
            for host in value { try? await retireStoredHost(host) }
        }
    }
    private func validateKeys(_ keys: DeviceKeyReference) throws {
        guard (16...256).contains(keys.connectionTag.count), (16...256).contains(keys.verificationTag.count),
              keys.connectionTag != keys.verificationTag, keys.connectionSpki.count == 91, keys.verificationSpki.count == 91,
              keys.connectionSpki != keys.verificationSpki else { throw NativeFailure.storageUnavailable }
    }
    private func validate(_ host: NativeRegisteredHost) throws {
        let time = Date().timeIntervalSince1970 * 1000
        guard time >= 0, time <= Double(LinkBytes.maximumInteger) else { throw NativeFailure.expired }
        guard !host.name.isEmpty, host.name.count <= 80,
              !host.name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              host.device.knockKey.count == 32, LinkBytes.matches(host.device.deviceId, "dev_[A-Za-z0-9_-]{22}"),
              LinkBytes.base32(LinkBytes.hash(host.device.rootSpki)) == host.device.hostId else { throw NativeFailure.storageUnavailable }
        try validateKeys(host.keys)
        _ = try AddressBookCodec.discoveryKey(host.device.signedAddressBook, rootSpki: host.device.rootSpki, deviceId: host.device.deviceId,
            nowMs: UInt64(time), priorGeneration: host.device.bookGeneration, priorHash: host.device.bookHash)
    }
    public func list() -> [NativeRegisteredHost] { closed ? [] : hosts }
    public func save(_ host: NativeRegisteredHost) async throws {
        try await serializeProfiles { try await self.saveHost(host) }
    }
    private func saveHost(_ host: NativeRegisteredHost) async throws {
        guard !closed else { throw NativeFailure.storageUnavailable }; try validate(host)
        guard !retirements.contains(where: { $0.id == host.id }) else { throw NativeFailure.revoked }
        if let previous = hosts.first(where: { $0.id == host.id }) {
            guard host.device.bookGeneration >= previous.device.bookGeneration,
                  host.device.bookGeneration != previous.device.bookGeneration || host.device.bookHash == previous.device.bookHash,
                  host.device.knockKey == previous.device.knockKey,
                  host.keys.connectionTag == previous.keys.connectionTag, host.keys.verificationTag == previous.keys.verificationTag,
                  host.keys.connectionSpki == previous.keys.connectionSpki, host.keys.verificationSpki == previous.keys.verificationSpki else { throw NativeFailure.identityMismatch }
        }
        var next = hosts.filter { $0.id != host.id }; next.append(host)
        guard next.count + retirements.count <= 16 else { throw NativeFailure.storageUnavailable }
        try await vault.storeMetadata(JSONEncoder().encode(next), name: "hosts")
        guard !closed else { throw NativeFailure.storageUnavailable }
        hosts = next
    }
    public func draft() async throws -> NativePairingDraft? {
        guard !closed else { throw NativeFailure.storageUnavailable }
        guard let data = try await vault.metadata(name: "pairing") else { return nil }
        guard !closed else { throw NativeFailure.storageUnavailable }
        let value = try JSONDecoder().decode(NativePairingDraft.self, from: data)
        guard value.payload.utf8.count <= 16_384, value.name.count <= 80 else { throw NativeFailure.storageUnavailable }
        try validateKeys(value.keys); return value
    }
    public func saveDraft(_ draft: NativePairingDraft) async throws {
        try await serializeProfiles { try await self.saveDraftOnce(draft) }
    }
    private func saveDraftOnce(_ draft: NativePairingDraft) async throws {
        guard !closed, !draft.name.isEmpty, draft.name.count <= 80 else { throw NativeFailure.storageUnavailable }
        _ = try PairingInvitation.parse(draft.payload); try validateKeys(draft.keys)
        if let existing = try await self.draft() {
            guard existing.payload == draft.payload, existing.keys.connectionTag == draft.keys.connectionTag,
                  existing.keys.verificationTag == draft.keys.verificationTag, existing.name == draft.name else { throw NativeFailure.resultUnknown }
        }
        try await vault.storeMetadata(JSONEncoder().encode(draft), name: "pairing")
    }
    public func clearDraft(matching payload: String? = nil) async throws {
        try await serializeProfiles { try await self.removeDraft(matching: payload, abandon: false) }
    }
    public func abandonDraft() async throws {
        try await serializeProfiles { try await self.removeDraft(matching: nil, abandon: true) }
    }
    private func removeDraft(matching payload: String?, abandon: Bool) async throws {
        guard let draft = try await draft() else { return }
        guard payload == nil || draft.payload == payload else { throw NativeFailure.resultUnknown }
        try await vault.remove(name: "pairing", body: false)
        if abandon, !hosts.contains(where: { $0.keys.connectionTag == draft.keys.connectionTag || $0.keys.verificationTag == draft.keys.verificationTag }) {
            try await eraseKeys(draft.keys)
        }
    }
    public func hostVault(_ host: NativeRegisteredHost) async throws -> EncryptedVault {
        guard let key, !closed, hosts.contains(where: { $0.id == host.id }) else { throw NativeFailure.storageUnavailable }
        try validate(host)
        if let previous = children.removeValue(forKey: host.id) { await previous.lock() }
        guard !closed else { throw NativeFailure.storageUnavailable }
        let child = try EncryptedVault(directory: root.appendingPathComponent("cache").appendingPathComponent(host.id), key: key,
            binding: host.id)
        children[host.id] = child; return child
    }
    public func retire(_ host: NativeRegisteredHost, proof: VerifiedNativeRevocation) async throws {
        try await serializeProfiles { try await self.retireHost(host, proof: proof) }
    }
    private func retireHost(_ host: NativeRegisteredHost, proof: VerifiedNativeRevocation) async throws {
        guard proof.hostId == host.device.hostId, proof.deviceId == host.device.deviceId else { throw NativeFailure.identityMismatch }
        try await retireStoredHost(host)
    }
    private func retireStoredHost(_ host: NativeRegisteredHost) async throws {
        let next = hosts.filter { $0.id != host.id }
        hosts = next
        let pending = retirements.filter { $0.id != host.id } + [host]
        var failed = false
        if let child = children.removeValue(forKey: host.id) { await child.lock() }
        if pending.count <= 16 {
            do { try await vault.storeMetadata(JSONEncoder().encode(pending), name: "retirements"); if !closed { retirements = pending } }
            catch { failed = true }
        } else { failed = true }
        do { try await eraseKeys(host.keys) } catch { failed = true }
        do { try await vault.storeMetadata(JSONEncoder().encode(next), name: "hosts") } catch { failed = true }
        do { try FileManager.default.removeItem(at: root.appendingPathComponent("cache").appendingPathComponent(host.id)) }
        catch { if (error as NSError).code != NSFileNoSuchFileError { failed = true } }
        if !failed {
            let remaining = retirements.filter { $0.id != host.id }
            do { try await vault.storeMetadata(JSONEncoder().encode(remaining), name: "retirements"); if !closed { retirements = remaining } }
            catch { failed = true }
        }
        if failed { throw NativeFailure.storageUnavailable }
    }
    private func serializeProfiles(_ operation: @escaping @Sendable () async throws -> Void) async throws {
        let previous = profileTail
        let next = Task { if let previous { await previous.value }; try await operation() }
        profileTail = Task { _ = try? await next.value }
        try await next.value
    }
    public func lock() async {
        closed = true; key = nil; hosts = []; retirements = []
        let previous = Array(children.values); children.removeAll()
        await vault.lock()
        for child in previous { await child.lock() }
    }
}

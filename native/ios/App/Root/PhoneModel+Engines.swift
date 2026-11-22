import LatchNativeCore

/** A session's engine by the catalog. */
extension PhoneModel {
    func engineInfo(_ harnessId: String?) -> NativeJSON {
        snapshot["catalog"]["harnesses"].array.first { $0["id"].string == harnessId } ?? .null
    }
    func engineMark(_ harnessId: String?) -> String? {
        let info = engineInfo(harnessId)
        return info != .null ? PhoneStart.mark(info) : harnessId.map(PhoneStart.removedMark)
    }
    func engineName(_ harnessId: String?) -> String {
        let info = engineInfo(harnessId)
        if info != .null { return PhoneStart.engineName(info) }
        // A session keeps the identifier of an engine since removed, and should not read as if another ran it.
        return harnessId ?? "Harness"
    }
}

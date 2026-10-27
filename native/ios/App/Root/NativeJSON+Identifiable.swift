import LatchNativeCore

extension NativeJSON: @retroactive Identifiable {
    public var id: String { self["id"].string ?? "invalid" }
}

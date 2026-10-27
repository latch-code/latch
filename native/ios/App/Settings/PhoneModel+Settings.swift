import LatchNativeCore

extension PhoneModel {
    func pauseInput() async {
        guard let workspace else { return }
        do { _ = try await workspace.freeAction(path: "/link/api/native/input/pause", fields: [:]); await refresh() }
        catch { report(error) }
    }
}

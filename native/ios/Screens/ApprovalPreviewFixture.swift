#if LATCH_SCREENS && targetEnvironment(simulator)
import Foundation

enum ApprovalPreviewFixture {
    static func install(route: String) -> String {
        let status = ApprovalSessionPreview.installFixtureKey(Data(repeating: 0x2a, count: 32), route: route)
        return "write=\(status.write)\nread=\(status.read)\n"
    }
}
#endif

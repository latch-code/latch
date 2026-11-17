// The live picture of one booted iOS simulator, read from the screen's IOSurface and encoded to H.264 (or JPEG), for
// the Host over framed stdin and stdout. Pictures only: this build sends no touches, keys or buttons to any device.
//
// Apple private frameworks, inside this helper only. CoreSimulator is opened with dlopen from its system location (or
// the selected Xcode) and used through the Objective-C runtime, with no link-time dependency: SimServiceContext finds
// the device, its IO port that adopts SimScreenAdapter lists the screens, and SimScreen's
// registerScreenCallbacks… hands over the framebuffer IOSurface and a callback per frame. Every class, protocol and
// method is checked against the type encoding this file was written for before it is called; anything missing or
// different reports frames as unsupported (with a short reason, at most 128 characters) instead of calling it. Block
// parameters encode only as `@?`, so the callbacks' own signatures cannot be checked this way. SimulatorKit is not
// loaded: nothing here needs it. Encoding is public VideoToolbox. No system permission (screen recording,
// accessibility) is involved. This file's own code starts no process, writes no file and uses no network;
// CoreSimulator, inside this process, talks to CoreSimulatorService over XPC (launchd starts it if needed) and writes
// its own logs. A developer directory chosen through the environment (DEVELOPER_DIR) is refused.
//
// Usage: `latch-simulator --udid <UDID>` (an upper-case UUID, nothing else), `--version`, and three self-tests that
// touch no device: `--self-test` (resolves the frameworks, classes and codecs and prints the capability table as
// JSON), `--self-test changed-interface` (the same with one expected method shape altered, as a newer Xcode would
// change it), `--self-test protocol` (reads framed requests from stdin and answers each as the request checks decide,
// a valid one with ok, no device behind it). The helper exits when stdin closes, when the device shuts down or
// disappears, or on SIGTERM, including while it is still attaching.
//
// Framing, both directions: one type byte, the payload's length as a 4-byte big-endian integer, then the payload.
// Requests from the Host carry JSON objects with an integer "id" (1…2^31-1); every request gets exactly one result.
// A request payload over 65 536 bytes is a protocol error: the helper answers id 0 and exits (it cannot resynchronise).
// At most 64 requests wait to be handled (the reader stops reading stdin beyond that), and at most 64 messages wait for
// stdout: a Host that keeps writing requests without reading the results ends the helper (exit status 3).
//
// Host to helper (stdin):
//   0x01 start     {"id", "codec": "h264"|"jpeg", "maxFps": 1…60, "maxDimension": 160…4096}  (re)starts the stream
//   0x02 stop      {"id"}
//   0x03 keyframe  {"id"}  the next frame is a keyframe, sent at once even if the screen did not change
//   0x04 ping      {"id"}
//   0x10…0x3f      reserved for input (touch, keyboard, buttons, orientation). Not implemented in this build: each is
//                  answered {"id", "ok": false, "error": "unsupported"}. Any other unknown type gets "unknown-type".
//                  Neither ends the stream, so a newer Host can probe an older helper.
// Helper to Host (stdout):
//   0x81 capabilities  first message, once: {"protocol": 1, "version", "frames": {"available", "reason"?},
//                      "codecs": {"h264", "jpeg"}, "input": {"touch"|"keyboard"|"buttons"|"orientation":
//                      {"available": false, "reason": "not-built"}}}. When frames are unavailable the helper exits next.
//   0x82 description   {"codec", "codecString"?, "config"? (base64 avcC), "width", "height" (encoded pixels),
//                      "sourceWidth", "sourceHeight" (device pixels), "scale" (pixels per point), "orientation"
//                      (SimScreen's uiOrientation, 0 unknown, 1 portrait, 2 upside down, 3 and 4 landscape)}.
//                      Sent after start, before every H.264 keyframe, and whenever any of these change.
//   0x83 frame         binary: flags (1 byte, bit 0 keyframe), timestamp (8 bytes big-endian, microseconds since the
//                      stream started), then one H.264 access unit in AVCC form (4-byte NAL lengths) or one JPEG.
//                      At most 8 MiB.
//   0x84 result        {"id", "ok", "error"?}
//   0x85 gone          {"reason": "shutdown"|"not-found"}; the helper exits next.
// Control payloads are at most 65 536 bytes. Diagnostics go to stderr as short lines, never picture content.
//
// Pacing and back-pressure: a timer at maxFps encodes only when the screen changed (frame callback or IOSurface seed),
// plus one settling frame half a second after the last change, so an idle screen sends nothing. One encoded frame waits
// for stdout at most: while it waits, ticks are skipped before encoding (the H.264 reference chain stays whole), and a
// frame that cannot be queued is dropped and the next one forced to be a keyframe. Results never wait behind more than
// the one frame being written.
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import IOSurface
import ObjectiveC
import VideoToolbox

private let helperVersion = "1.0.0"
private let protocolVersion = 1
private let requestLimit = 65_536
private let frameLimit = 8 * 1_048_576
private let controlQueueLimit = 64
private let requestsInFlight = 64
private let reasonLimit = 128
private let bootedState: UInt64 = 3
private let mainScreenType: UInt64 = 0
private let keyframeIntervalSeconds = 5
private let settleNanoseconds: UInt64 = 500_000_000
private let fpsRange = 1...60
private let dimensionRange = 160...4096

private enum Inbound: UInt8 { case start = 0x01, stop = 0x02, keyframe = 0x03, ping = 0x04 }
private let reservedInput: ClosedRange<UInt8> = 0x10...0x3f
private enum Outbound: UInt8 { case capabilities = 0x81, description = 0x82, frame = 0x83, result = 0x84, gone = 0x85 }

private func diagnose(_ text: String) {
  let line = "latch-simulator: \(text)\n"
  line.utf8CString.withUnsafeBufferPointer { _ = Darwin.write(STDERR_FILENO, $0.baseAddress!, $0.count - 1) }
}

private func json(_ object: [String: Any]) -> Data {
  (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
}

private func header(_ type: UInt8, _ length: Int) -> Data {
  let value = UInt32(length)
  return Data([type, UInt8(value >> 24), UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)])
}

// MARK: - Output

/** The only writer of stdout. Control messages go first; one frame at most waits behind them. */
private final class Output: @unchecked Sendable {
  private let condition = NSCondition()
  private var control: [Data] = []
  private var frame: Data?
  private var exitStatus: Int32?
  private var writingFrame = false

  init() {
    let thread = Thread { [self] in run() }
    thread.name = "latch-simulator.output"
    thread.start()
  }

  func send(_ type: Outbound, _ object: [String: Any]) {
    var message = json(object)
    guard message.count <= requestLimit else { diagnose("control message too large"); return }
    message = header(type.rawValue, message.count) + message
    condition.lock()
    defer { condition.unlock() }
    guard exitStatus == nil else { return }
    // A Host that keeps sending requests without reading the results is not a peer to wait for.
    guard control.count < controlQueueLimit else { diagnose("results are not being read"); Darwin._exit(3) }
    control.append(message)
    condition.signal()
  }

  /** Whether a frame is waiting to be written: the encoder skips a tick instead of making one. */
  var busy: Bool {
    condition.lock()
    defer { condition.unlock() }
    return frame != nil
  }

  /** Queues a whole frame message, or returns false when the slot is still taken. */
  func offer(frame message: Data) -> Bool {
    condition.lock()
    defer { condition.unlock() }
    guard exitStatus == nil, frame == nil else { return false }
    frame = message
    condition.signal()
    return true
  }

  /** Writes what control messages are queued (a waiting frame is dropped), then exits; after two seconds regardless. */
  func finish(_ status: Int32) -> Never {
    condition.lock()
    if exitStatus == nil { exitStatus = status }
    if !writingFrame { frame = nil }
    condition.signal()
    condition.unlock()
    usleep(2_000_000)
    Darwin._exit(status)
  }

  private func run() {
    while true {
      condition.lock()
      while control.isEmpty && frame == nil && exitStatus == nil { condition.wait() }
      let next: Data?
      if !control.isEmpty { next = control.removeFirst() }
      else if exitStatus == nil, let waiting = frame { next = waiting; writingFrame = true }
      else { next = nil }
      let status = exitStatus
      condition.unlock()
      guard let next else { Darwin._exit(status ?? 0) }
      if !write(next) { Darwin._exit(status ?? 0) }
      condition.lock()
      // The frame slot is freed only once its bytes are out: that is the back-pressure the encoder sees.
      if writingFrame { frame = nil; writingFrame = false }
      condition.unlock()
    }
  }

  private func write(_ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let count = Darwin.write(STDOUT_FILENO, raw.baseAddress!.advanced(by: offset), raw.count - offset)
        if count < 0 && errno == EINTR { continue }
        if count <= 0 { return false }
        offset += count
      }
      return true
    }
  }
}

// MARK: - Private framework access

private struct Unsupported: Error { let reason: String }

/** Type encodings without the frame offsets, which is the part that says how to call a method. */
private func shape(_ encoding: UnsafePointer<CChar>?) -> String {
  guard let encoding else { return "" }
  return String(cString: encoding).filter { !$0.isNumber }
}

private func instanceMethod(_ className: String, _ selector: String, _ expected: String) throws {
  guard let type: AnyClass = NSClassFromString(className) else { throw Unsupported(reason: "missing-class:\(className)") }
  guard let method = class_getInstanceMethod(type, NSSelectorFromString(selector)),
    shape(method_getTypeEncoding(method)) == expected else { throw Unsupported(reason: "changed-method:\(className).\(selector)") }
}

private func classMethod(_ className: String, _ selector: String, _ expected: String) throws {
  guard let type: AnyClass = NSClassFromString(className) else { throw Unsupported(reason: "missing-class:\(className)") }
  guard let method = class_getClassMethod(type, NSSelectorFromString(selector)),
    shape(method_getTypeEncoding(method)) == expected else { throw Unsupported(reason: "changed-method:\(className)+\(selector)") }
}

private func protocolMethod(_ protocolName: String, _ selector: String, _ expected: String) throws {
  guard let value = objc_getProtocol(protocolName) else { throw Unsupported(reason: "missing-protocol:\(protocolName)") }
  let description = protocol_getMethodDescription(value, NSSelectorFromString(selector), true, true)
  guard description.name != nil, shape(description.types) == expected else {
    throw Unsupported(reason: "changed-method:\(protocolName).\(selector)")
  }
}

private enum InterfaceKind { case classMethod, instanceMethod, protocolMethod }

private struct Interface {
  let kind: InterfaceKind
  let owner: String
  let selector: String
  let shape: String
}

/**
 * Every private class, protocol and method this helper calls, with the shape it calls it with. A block parameter is
 * only `@?` here: its own argument types are not part of the encoding and stay unchecked.
 */
private let interfaces: [Interface] = [
  Interface(kind: .classMethod, owner: "SimServiceContext", selector: "sharedServiceContextForDeveloperDir:error:", shape: "@@:@^@"),
  Interface(kind: .instanceMethod, owner: "SimServiceContext", selector: "defaultDeviceSetWithError:", shape: "@@:^@"),
  Interface(kind: .instanceMethod, owner: "SimDeviceSet", selector: "devices", shape: "@@:"),
  Interface(kind: .instanceMethod, owner: "SimDevice", selector: "UDID", shape: "@@:"),
  Interface(kind: .instanceMethod, owner: "SimDevice", selector: "state", shape: "Q@:"),
  Interface(kind: .instanceMethod, owner: "SimDevice", selector: "io", shape: "@@:"),
  Interface(kind: .instanceMethod, owner: "SimDevice", selector: "deviceType", shape: "@@:"),
  Interface(kind: .instanceMethod, owner: "SimDeviceType", selector: "mainScreenScale", shape: "f@:"),
  Interface(kind: .protocolMethod, owner: "SimDeviceIOProtocol", selector: "ioPorts", shape: "@@:"),
  Interface(kind: .protocolMethod, owner: "SimDeviceIOPortInterface", selector: "descriptor", shape: "@@:"),
  Interface(kind: .protocolMethod, owner: "SimScreenAdapter", selector: "enumerateScreensWithCompletionQueue:completionHandler:", shape: "v@:@@?"),
  Interface(
    kind: .protocolMethod, owner: "SimScreen",
    selector: "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:",
    shape: "v@:@@@?@?@?"),
  Interface(kind: .protocolMethod, owner: "SimScreen", selector: "unregisterScreenCallbacksWithUUID:", shape: "v@:@"),
  Interface(kind: .protocolMethod, owner: "SimScreen", selector: "screenProperties", shape: "@@:"),
  Interface(kind: .protocolMethod, owner: "SimScreenProperties", selector: "screenID", shape: "I@:"),
  Interface(kind: .protocolMethod, owner: "SimScreenProperties", selector: "screenType", shape: "Q@:"),
  Interface(kind: .protocolMethod, owner: "SimScreenProperties", selector: "pixelSize", shape: "{CGSize=dd}@:"),
  Interface(kind: .protocolMethod, owner: "SimScreenProperties", selector: "uiOrientation", shape: "I@:"),
]

/** For `--self-test changed-interface`: the frame-callback registration as a newer Xcode might have reshaped it. */
private func changedInterfaces() -> [Interface] {
  interfaces.map { item in
    item.selector.hasPrefix("registerScreenCallbacks") ? Interface(kind: item.kind, owner: item.owner, selector: item.selector, shape: "v@:@") : item
  }
}

private func checkInterfaces(_ list: [Interface] = interfaces) throws {
  for item in list {
    switch item.kind {
    case .classMethod: try classMethod(item.owner, item.selector, item.shape)
    case .instanceMethod: try instanceMethod(item.owner, item.selector, item.shape)
    case .protocolMethod: try protocolMethod(item.owner, item.selector, item.shape)
    }
  }
}

private typealias DeveloperDirFunction = @convention(c) (
  UnsafeMutablePointer<CChar>, Int32, UnsafeMutablePointer<Bool>, UnsafeMutablePointer<Bool>, UnsafeMutablePointer<Bool>
) -> Bool

/** The selected Xcode, as `xcode-select -p` reports it, without starting a process. */
private func developerDirectory() throws -> String {
  var path: String?
  if let library = dlopen("/usr/lib/libxcselect.dylib", RTLD_NOW | RTLD_LOCAL),
    let symbol = dlsym(library, "xcselect_get_developer_dir_path") {
    let function = unsafeBitCast(symbol, to: DeveloperDirFunction.self)
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) + 1)
    var fromEnvironment = false, fromCommandLineTools = false, fromDefault = false
    if function(&buffer, Int32(MAXPATHLEN), &fromEnvironment, &fromCommandLineTools, &fromDefault) {
      // The Host starts the helper with an empty environment; a DEVELOPER_DIR that got here anyway is not followed.
      if fromEnvironment { throw Unsupported(reason: "developer-dir-from-environment") }
      path = String(validatingCString: buffer)
    }
  }
  guard let path, path.hasPrefix("/"), path.hasSuffix("/Contents/Developer") else { throw Unsupported(reason: "no-xcode") }
  var directory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue else {
    throw Unsupported(reason: "no-xcode")
  }
  return path
}

/** CoreSimulator: the system copy that Xcode installs, else the selected Xcode's own. */
private func loadCoreSimulator(_ developer: String) throws {
  let candidates = [
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
    developer + "/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
  ]
  for candidate in candidates where FileManager.default.fileExists(atPath: candidate) {
    if dlopen(candidate, RTLD_NOW | RTLD_GLOBAL) != nil { return }
    diagnose("CoreSimulator did not load")
  }
  throw Unsupported(reason: "no-coresimulator")
}

private func codecAvailable(_ codec: CMVideoCodecType) -> Bool {
  var session: VTCompressionSession?
  let status = VTCompressionSessionCreate(
    allocator: nil, width: 64, height: 64, codecType: codec, encoderSpecification: nil, imageBufferAttributes: nil,
    compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
  guard status == noErr, let session else { return false }
  VTCompressionSessionInvalidate(session)
  return true
}

private func capabilities(frames: Result<Void, Unsupported>, h264: Bool, jpeg: Bool) -> [String: Any] {
  var framesEntry: [String: Any] = ["available": false]
  switch frames {
  case .success: framesEntry["available"] = h264 || jpeg
    if !(h264 || jpeg) { framesEntry["reason"] = "no-encoder" }
  case .failure(let failure): framesEntry["reason"] = String(failure.reason.prefix(reasonLimit))
  }
  let unavailable: [String: Any] = ["available": false, "reason": "not-built"]
  return [
    "protocol": protocolVersion, "version": helperVersion, "frames": framesEntry, "codecs": ["h264": h264, "jpeg": jpeg],
    "input": ["touch": unavailable, "keyboard": unavailable, "buttons": unavailable, "orientation": unavailable],
  ]
}

// Calls through the Objective-C runtime. Each shape was checked by checkInterfaces() before any of these runs.
private typealias ObjectGetter = @convention(c) (AnyObject, Selector) -> Unmanaged<AnyObject>?
private typealias UInt64Getter = @convention(c) (AnyObject, Selector) -> UInt64
private typealias UInt32Getter = @convention(c) (AnyObject, Selector) -> UInt32
private typealias FloatGetter = @convention(c) (AnyObject, Selector) -> Float
private typealias SizeGetter = @convention(c) (AnyObject, Selector) -> CGSize
// NSError out-parameters are autoreleasing: the callee does not hand over ownership of what it writes back.
private typealias ContextFactory = @convention(c) (AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>?) -> Unmanaged<AnyObject>?
private typealias ErrorGetter = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>?) -> Unmanaged<AnyObject>?
private typealias ScreenEnumerator = @convention(c) (
  AnyObject, Selector, DispatchQueue, @escaping @convention(block) (NSArray?, NSError?) -> Void
) -> Void
private typealias ScreenRegistrar = @convention(c) (
  AnyObject, Selector, NSUUID, DispatchQueue, @escaping @convention(block) () -> Void,
  @escaping @convention(block) (AnyObject?, AnyObject?) -> Void, @escaping @convention(block) (AnyObject?) -> Void
) -> Void
private typealias ScreenUnregistrar = @convention(c) (AnyObject, Selector, NSUUID) -> Void

private func implementation<T>(_ object: AnyObject, _ name: String, as _: T.Type) throws -> (T, Selector) {
  let selector = NSSelectorFromString(name)
  guard let object = object as? NSObject, object.responds(to: selector), let pointer = object.method(for: selector) else {
    throw Unsupported(reason: "changed-method:\(name)")
  }
  return (unsafeBitCast(pointer, to: T.self), selector)
}

private func object(_ target: AnyObject, _ name: String) throws -> AnyObject? {
  let (function, selector) = try implementation(target, name, as: ObjectGetter.self)
  return function(target, selector)?.takeUnretainedValue()
}

private func unsigned64(_ target: AnyObject, _ name: String) throws -> UInt64 {
  let (function, selector) = try implementation(target, name, as: UInt64Getter.self)
  return function(target, selector)
}

private func unsigned32(_ target: AnyObject, _ name: String) throws -> UInt32 {
  let (function, selector) = try implementation(target, name, as: UInt32Getter.self)
  return function(target, selector)
}

// MARK: - Device and screen

private struct ScreenState {
  var sourceWidth: Int
  var sourceHeight: Int
  var orientation: UInt32
}

private final class Device: @unchecked Sendable {
  let device: AnyObject
  let screen: AnyObject
  let scale: Double

  init(device: AnyObject, screen: AnyObject, scale: Double) {
    self.device = device
    self.screen = screen
    self.scale = scale
  }

  static func attach(udid: String, developer: String) throws -> Device {
    guard let type: AnyClass = NSClassFromString("SimServiceContext"),
      let method = class_getClassMethod(type, NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")) else {
      throw Unsupported(reason: "missing-class:SimServiceContext")
    }
    var error: NSError?
    let factory = unsafeBitCast(method_getImplementation(method), to: ContextFactory.self)
    guard let context = factory(type, NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), developer as NSString, &error)?
      .takeUnretainedValue() else { throw Unsupported(reason: "no-service") }
    let (setGetter, setSelector) = try implementation(context, "defaultDeviceSetWithError:", as: ErrorGetter.self)
    guard let set = setGetter(context, setSelector, &error)?.takeUnretainedValue(),
      let devices = try object(set, "devices") as? NSArray else { throw Unsupported(reason: "no-device-set") }
    var found: AnyObject?
    for case let candidate as NSObject in devices {
      if let identifier = try object(candidate, "UDID") as? NSUUID, identifier.uuidString == udid { found = candidate; break }
    }
    guard let device = found else { throw Unsupported(reason: "device-not-found") }
    guard try unsigned64(device, "state") == bootedState else { throw Unsupported(reason: "device-not-booted") }
    var scale = 1.0
    if let deviceType = try object(device, "deviceType") {
      let (function, selector) = try implementation(deviceType, "mainScreenScale", as: FloatGetter.self)
      let value = Double(function(deviceType, selector))
      if value.isFinite, (1...4).contains(value) { scale = value }
    }
    guard let io = try object(device, "io"), let ports = try object(io, "ioPorts") as? NSArray,
      let adapterProtocol = objc_getProtocol("SimScreenAdapter") else { throw Unsupported(reason: "no-io") }
    var adapter: AnyObject?
    for case let port as NSObject in ports {
      if let descriptor = try object(port, "descriptor") as? NSObject, descriptor.conforms(to: adapterProtocol) { adapter = descriptor; break }
    }
    guard let adapter else { throw Unsupported(reason: "no-screen-adapter") }
    return Device(device: device, screen: try mainScreen(adapter), scale: scale)
  }

  /** The device's built-in display: the screen of type 0 with the lowest ID. */
  private static func mainScreen(_ adapter: AnyObject) throws -> AnyObject {
    let (enumerate, selector) = try implementation(adapter, "enumerateScreensWithCompletionQueue:completionHandler:", as: ScreenEnumerator.self)
    final class Box: @unchecked Sendable { var screens: [AnyObject] = [] }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    enumerate(adapter, selector, DispatchQueue(label: "latch-simulator.enumerate")) { screens, _ in
      box.screens = (screens as? [AnyObject]) ?? []
      done.signal()
    }
    guard done.wait(timeout: .now() + 10) == .success else { throw Unsupported(reason: "screen-timeout") }
    var best: (id: UInt32, screen: AnyObject)?
    for screen in box.screens {
      guard let properties = try object(screen, "screenProperties") else { continue }
      guard try unsigned64(properties, "screenType") == mainScreenType else { continue }
      let id = try unsigned32(properties, "screenID")
      if best == nil || id < best!.id { best = (id, screen) }
    }
    guard let best else { throw Unsupported(reason: "no-main-screen") }
    return best.screen
  }

  var booted: Bool { (try? unsigned64(device, "state")) == bootedState }

  func state(_ properties: AnyObject?) -> ScreenState? {
    guard let properties = properties ?? (try? object(screen, "screenProperties")) ?? nil,
      let getter = try? implementation(properties, "pixelSize", as: SizeGetter.self) else { return nil }
    let size = getter.0(properties, getter.1)
    guard size.width.isFinite, size.height.isFinite, size.width >= 1, size.height >= 1, size.width <= 16_384, size.height <= 16_384
    else { return nil }
    return ScreenState(
      sourceWidth: Int(size.width), sourceHeight: Int(size.height), orientation: (try? unsigned32(properties, "uiOrientation")) ?? 0)
  }

  func register(
    _ id: NSUUID, queue: DispatchQueue, frame: @escaping @convention(block) () -> Void,
    surfaces: @escaping @convention(block) (AnyObject?, AnyObject?) -> Void, properties: @escaping @convention(block) (AnyObject?) -> Void
  ) throws {
    let (function, selector) = try implementation(
      screen, "registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:",
      as: ScreenRegistrar.self)
    function(screen, selector, id, queue, frame, surfaces, properties)
  }

  func unregister(_ id: NSUUID) {
    guard let call = try? implementation(screen, "unregisterScreenCallbacksWithUUID:", as: ScreenUnregistrar.self) else { return }
    call.0(screen, call.1, id)
  }
}

// MARK: - Encoding

private enum Codec: String { case h264, jpeg }

private struct Settings {
  let codec: Codec
  let maxFps: Int
  let maxDimension: Int
}

private struct Encoded {
  let data: Data
  let keyframe: Bool
  let config: Data?
}

/** One VideoToolbox session at one output size; replaced when the size, the surface or the settings change. */
private final class Encoder {
  let codec: Codec
  let width: Int
  let height: Int
  private let session: VTCompressionSession
  private let transfer: VTPixelTransferSession
  private let pool: CVPixelBufferPool

  init?(codec: Codec, width: Int, height: Int, fps: Int) {
    var session: VTCompressionSession?
    let codecType = codec == .h264 ? kCMVideoCodecType_H264 : kCMVideoCodecType_JPEG
    guard VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height), codecType: codecType, encoderSpecification: nil,
      imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
      == noErr, let session else { return nil }
    var transfer: VTPixelTransferSession?
    guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer) == noErr, let transfer else {
      VTCompressionSessionInvalidate(session)
      return nil
    }
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height, kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any],
    ]
    var pool: CVPixelBufferPool?
    guard CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey: 2] as CFDictionary, attributes as CFDictionary, &pool)
      == kCVReturnSuccess, let pool else {
      VTCompressionSessionInvalidate(session)
      VTPixelTransferSessionInvalidate(transfer)
      return nil
    }
    func set(_ key: CFString, _ value: CFTypeRef) { _ = VTSessionSetProperty(session, key: key, value: value) }
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
    if codec == .h264 {
      set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Main_AutoLevel)
      set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
      set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: keyframeIntervalSeconds))
      set(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: keyframeIntervalSeconds * fps))
      set(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps))
      set(kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: min(8_000_000, max(500_000, width * height * 4))))
    } else {
      set(kVTCompressionPropertyKey_Quality, NSNumber(value: 0.7))
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
    self.codec = codec
    self.width = width
    self.height = height
    self.session = session
    self.transfer = transfer
    self.pool = pool
  }

  deinit {
    VTCompressionSessionInvalidate(session)
    VTPixelTransferSessionInvalidate(transfer)
  }

  /** Copies and scales the live surface first, so the device drawing the next frame cannot tear this one. */
  func encode(_ source: CVPixelBuffer, at microseconds: UInt64, forceKeyframe: Bool) -> Encoded? {
    var copy: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &copy) == kCVReturnSuccess, let copy,
      VTPixelTransferSessionTransferImage(transfer, from: source, to: copy) == noErr else { return nil }
    final class Box: @unchecked Sendable { var result: Encoded?; let lock = NSLock() }
    let box = Box()
    let time = CMTime(value: CMTimeValue(microseconds), timescale: 1_000_000)
    let properties = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
    let status = VTCompressionSessionEncodeFrame(
      session, imageBuffer: copy, presentationTimeStamp: time, duration: .invalid, frameProperties: properties, infoFlagsOut: nil
    ) { status, flags, sample in
      guard status == noErr, !flags.contains(.frameDropped), let sample, let encoded = Encoder.read(sample) else { return }
      box.lock.lock()
      box.result = encoded
      box.lock.unlock()
    }
    guard status == noErr else { return nil }
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: time)
    box.lock.lock()
    defer { box.lock.unlock() }
    return box.result
  }

  private static func read(_ sample: CMSampleBuffer) -> Encoded? {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0, length <= frameLimit else { return nil }
    var data = Data(count: length)
    let copied = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
    guard copied == kCMBlockBufferNoErr else { return nil }
    var keyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]],
      let first = attachments.first, (first[kCMSampleAttachmentKey_NotSync as String] as? Bool) == true { keyframe = false }
    var config: Data?
    if let format = CMSampleBufferGetFormatDescription(sample),
      CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264,
      let atoms = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms)
        as? [String: Any], let avcC = atoms["avcC"] as? Data, avcC.count >= 4, avcC.count <= 4096 { config = avcC }
    return Encoded(data: data, keyframe: keyframe, config: config)
  }
}

// MARK: - Requests

private enum Request { case start(Settings), stop, keyframe, ping }

private enum Parsed {
  case request(id: Int, Request)
  case refused(id: Int, error: String)
}

/** A JSON integer (not a float or a boolean) within 1…2^31-1. */
private func positiveInteger(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFNumberGetTypeID(), !CFNumberIsFloatType(number) else { return nil }
  let value = number.int64Value
  return (1...Int64(Int32.max)).contains(value) ? Int(value) : nil
}

/**
 * Every check a request passes before anything acts on it. Touches no device or stream state, so
 * `--self-test protocol` runs exactly this. Input types are refused here: this build has no input to hand them to.
 */
private func parseRequest(_ type: UInt8, _ payload: Data) -> Parsed {
  guard let request = try? JSONSerialization.jsonObject(with: payload) as? [String: Any], let id = positiveInteger(request["id"]) else {
    return .refused(id: 0, error: "invalid-input")
  }
  guard let kind = Inbound(rawValue: type) else {
    return .refused(id: id, error: reservedInput.contains(type) ? "unsupported" : "unknown-type")
  }
  switch kind {
  case .start:
    guard Set(request.keys) == ["id", "codec", "maxFps", "maxDimension"], let name = request["codec"] as? String,
      let codec = Codec(rawValue: name), let fps = positiveInteger(request["maxFps"]), fpsRange.contains(fps),
      let dimension = positiveInteger(request["maxDimension"]), dimensionRange.contains(dimension)
    else { return .refused(id: id, error: "invalid-input") }
    return .request(id: id, .start(Settings(codec: codec, maxFps: fps, maxDimension: dimension)))
  case .stop, .keyframe, .ping:
    guard Set(request.keys) == ["id"] else { return .refused(id: id, error: "invalid-input") }
    return .request(id: id, kind == .stop ? .stop : kind == .keyframe ? .keyframe : .ping)
  }
}

private func sendResult(_ output: Output, _ id: Int, _ error: String?) {
  var result: [String: Any] = ["id": id, "ok": error == nil]
  if let error { result["error"] = error }
  output.send(.result, result)
}

/** What the stdin reader hands requests to, on the handler's own queue. */
private protocol RequestHandler: AnyObject, Sendable {
  var queue: DispatchQueue { get }
  func handle(_ type: UInt8, _ payload: Data)
  func end() -> Never
}

/** `--self-test protocol`: the request checks with nothing behind them; a request that passes is answered ok. */
private final class ProtocolProbe: RequestHandler, @unchecked Sendable {
  let queue = DispatchQueue(label: "latch-simulator.probe")
  private let output: Output

  init(output: Output) { self.output = output }

  func handle(_ type: UInt8, _ payload: Data) {
    switch parseRequest(type, payload) {
    case .refused(let id, let error): sendResult(output, id, error)
    case .request(let id, _): sendResult(output, id, nil)
    }
  }

  func end() -> Never { output.finish(0) }
}

// MARK: - Stream

/** Everything below runs on `queue`: requests, screen callbacks, ticks and encoding. */
private final class Stream: RequestHandler, @unchecked Sendable {
  let queue = DispatchQueue(label: "latch-simulator.stream", qos: .userInteractive)
  private let output: Output
  private let device: Device
  private let codecs: (h264: Bool, jpeg: Bool)
  private let registration = NSUUID()
  private var settings: Settings?
  private var registered = false
  private var timer: DispatchSourceTimer?
  private var surface: AnyObject?
  private var source: CVPixelBuffer?
  private var screen: ScreenState?
  private var encoder: Encoder?
  private var codec: Codec = .h264
  private var startedAt: UInt64 = 0
  private var dirty = false
  private var lastSeed: UInt32?
  private var lastChange: UInt64 = 0
  private var settlePending = false
  private var forceKeyframe = true
  private var described: [String: Any]?
  private var watcher: DispatchSourceTimer?

  init(output: Output, device: Device, codecs: (h264: Bool, jpeg: Bool)) {
    self.output = output
    self.device = device
    self.codecs = codecs
  }

  func watchDevice() {
    let watch = DispatchSource.makeTimerSource(queue: queue)
    watch.schedule(deadline: .now() + 1, repeating: 1)
    watch.setEventHandler { [self] in
      if !device.booted { gone("shutdown") }
    }
    watch.resume()
    watcher = watch
  }

  /** stdin closed or SIGTERM: stop quietly, without a gone message. */
  func end() -> Never {
    stopStream()
    output.finish(0)
  }

  func gone(_ reason: String) -> Never {
    stopStream()
    output.send(.gone, ["reason": reason])
    diagnose("device \(reason)")
    output.finish(0)
  }

  func handle(_ type: UInt8, _ payload: Data) {
    switch parseRequest(type, payload) {
    case .refused(let id, let error): sendResult(output, id, error)
    case .request(let id, let request): sendResult(output, id, perform(request))
    }
  }

  /** The error to answer with, or nil. */
  private func perform(_ request: Request) -> String? {
    switch request {
    case .start(let settings):
      guard settings.codec == .jpeg ? codecs.jpeg : (codecs.h264 || codecs.jpeg) else { return "codec-unavailable" }
      do { try start(settings) } catch let failure as Unsupported { return failure.reason } catch { return "failed" }
      return nil
    case .stop:
      stopStream()
      return nil
    case .keyframe:
      guard settings != nil else { return "not-streaming" }
      forceKeyframe = true
      dirty = true
      return nil
    case .ping:
      return nil
    }
  }

  private func start(_ next: Settings) throws {
    stopStream()
    settings = next
    codec = next.codec == .h264 && !codecs.h264 ? .jpeg : next.codec
    startedAt = DispatchTime.now().uptimeNanoseconds
    forceKeyframe = true
    dirty = true
    screen = device.state(nil)
    try device.register(
      registration, queue: queue,
      frame: { [weak self] in self?.dirty = true },
      surfaces: { [weak self] framebuffer, _ in self?.use(framebuffer) },
      properties: { [weak self] properties in self?.changed(properties) })
    registered = true
    let tick = DispatchSource.makeTimerSource(queue: queue)
    let interval = 1.0 / Double(next.maxFps)
    tick.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(2))
    tick.setEventHandler { [weak self] in self?.tick() }
    tick.resume()
    timer = tick
    diagnose("stream started: \(codec.rawValue), up to \(next.maxFps) fps, \(next.maxDimension) px")
  }

  private func stopStream() {
    timer?.cancel()
    timer = nil
    if registered { device.unregister(registration) }
    registered = false
    settings = nil
    encoder = nil
    surface = nil
    source = nil
    described = nil
    lastSeed = nil
    settlePending = false
  }

  private func use(_ framebuffer: AnyObject?) {
    guard settings != nil, let framebuffer, CFGetTypeID(framebuffer) == IOSurfaceGetTypeID() else { return }
    let reference = unsafeBitCast(framebuffer, to: IOSurfaceRef.self)
    var buffer: Unmanaged<CVPixelBuffer>?
    guard CVPixelBufferCreateWithIOSurface(nil, reference, nil, &buffer) == kCVReturnSuccess, let buffer else {
      diagnose("framebuffer is not a pixel buffer")
      return
    }
    surface = framebuffer
    source = buffer.takeRetainedValue()
    lastSeed = nil
    encoder = nil
    forceKeyframe = true
    dirty = true
  }

  private func changed(_ properties: AnyObject?) {
    guard settings != nil else { return }
    screen = device.state(properties) ?? screen
    encoder = nil
    forceKeyframe = true
    dirty = true
  }

  private func tick() {
    guard let settings, let surface, let source else { return }
    let now = DispatchTime.now().uptimeNanoseconds
    let seed = IOSurfaceGetSeed(unsafeBitCast(surface, to: IOSurfaceRef.self))
    if seed != lastSeed { dirty = true }
    let settle = !dirty && settlePending && now - lastChange >= settleNanoseconds
    guard dirty || settle else { return }
    // Skipped before encoding while the last frame is still being written: nothing is lost from the reference chain.
    guard !output.busy else { return }
    let width = CVPixelBufferGetWidth(source), height = CVPixelBufferGetHeight(source)
    let factor = min(1.0, Double(settings.maxDimension) / Double(max(width, height)))
    let outputWidth = max(16, Int(Double(width) * factor) & ~1), outputHeight = max(16, Int(Double(height) * factor) & ~1)
    if encoder == nil || encoder!.width != outputWidth || encoder!.height != outputHeight {
      encoder = Encoder(codec: codec, width: outputWidth, height: outputHeight, fps: settings.maxFps)
      if encoder == nil && codec == .h264 && codecs.jpeg {
        diagnose("H.264 encoder unavailable, using JPEG")
        codec = .jpeg
        encoder = Encoder(codec: codec, width: outputWidth, height: outputHeight, fps: settings.maxFps)
      }
      guard encoder != nil else { diagnose("no encoder"); return }
      forceKeyframe = true
    }
    let wasDirty = dirty
    dirty = false
    lastSeed = seed
    let microseconds = (now - startedAt) / 1000
    guard let encoded = encoder!.encode(source, at: microseconds, forceKeyframe: forceKeyframe) else {
      diagnose("frame not encoded")
      forceKeyframe = true
      return
    }
    if encoded.keyframe || codec == .jpeg { describe(encoded.config, width: outputWidth, height: outputHeight, always: codec == .h264) }
    var message = header(Outbound.frame.rawValue, 9 + encoded.data.count)
    message.append(encoded.keyframe ? 1 : 0)
    for shift in stride(from: 56, through: 0, by: -8) { message.append(UInt8(microseconds >> UInt64(shift) & 0xff)) }
    message.append(encoded.data)
    if output.offer(frame: message) {
      if encoded.keyframe { forceKeyframe = false }
    } else {
      // Dropped after encoding: later P-frames would refer to it, so the next frame starts a new chain.
      forceKeyframe = true
    }
    if wasDirty { lastChange = now; settlePending = true } else { settlePending = false }
  }

  private func describe(_ config: Data?, width: Int, height: Int, always: Bool) {
    let state = screen ?? ScreenState(sourceWidth: width, sourceHeight: height, orientation: 0)
    var value: [String: Any] = [
      "codec": codec.rawValue, "width": width, "height": height, "sourceWidth": state.sourceWidth,
      "sourceHeight": state.sourceHeight, "scale": device.scale, "orientation": state.orientation,
    ]
    if let config {
      value["config"] = config.base64EncodedString()
      value["codecString"] = String(format: "avc1.%02x%02x%02x", config[config.startIndex + 1], config[config.startIndex + 2], config[config.startIndex + 3])
    }
    if !always, let described, NSDictionary(dictionary: described).isEqual(to: value) { return }
    described = value
    output.send(.description, value)
  }
}

// MARK: - Input

/** The handler requests go to, set once the helper is ready for them. */
private final class HandlerSlot: @unchecked Sendable {
  private let condition = NSCondition()
  private var handler: RequestHandler?

  func set(_ value: RequestHandler) {
    condition.lock()
    handler = value
    condition.broadcast()
    condition.unlock()
  }

  var current: RequestHandler? {
    condition.lock()
    defer { condition.unlock() }
    return handler
  }

  /** The Host sends nothing before the capabilities, so this waits only on a Host that does. */
  func wait() -> RequestHandler {
    condition.lock()
    defer { condition.unlock() }
    while handler == nil { condition.wait() }
    return handler!
  }
}

/**
 * Reads frames from stdin on its own thread, from the moment the helper starts: the end of stdin ends the helper even
 * while CoreSimulator is still attaching, so a Host that dies then leaves nothing behind.
 */
private func startReader(_ slot: HandlerSlot, _ output: Output) {
  let reader = Thread { readRequests(slot, output) }
  reader.name = "latch-simulator.input"
  reader.start()
}

private func readRequests(_ slot: HandlerSlot, _ output: Output) {
  func exactly(_ count: Int) -> Data? {
    var data = Data(count: count)
    var offset = 0
    while offset < count {
      let read = data.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress!.advanced(by: offset), count - offset) }
      if read < 0 && errno == EINTR { continue }
      if read <= 0 { return nil }
      offset += read
    }
    return data
  }
  let inFlight = DispatchSemaphore(value: requestsInFlight)
  while true {
    guard let head = exactly(5) else { break }
    let length = Int(head[1]) << 24 | Int(head[2]) << 16 | Int(head[3]) << 8 | Int(head[4])
    guard length <= requestLimit else {
      // Requests read before this one still get their results first.
      if let handler = slot.current { handler.queue.sync {} }
      output.send(.result, ["id": 0, "ok": false, "error": "protocol"])
      diagnose("request too large")
      output.finish(2)
    }
    guard let payload = length == 0 ? Data() : exactly(length) else { break }
    let type = head[0]
    let handler = slot.wait()
    // Bounded: while the handler is busy (registering, encoding) stdin is left unread and the Host's writes back up.
    inFlight.wait()
    handler.queue.async {
      handler.handle(type, payload)
      inFlight.signal()
    }
  }
  if let handler = slot.current { handler.queue.sync { handler.end() } }
  output.finish(0)
}

// MARK: - Entry

private func isUDID(_ value: String) -> Bool {
  value.utf8.count == 36 && UUID(uuidString: value) != nil && value == value.uppercased()
}

@main private struct LatchSimulator {
  static func main() {
    signal(SIGPIPE, SIG_IGN)
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
      print("latch-simulator \(helperVersion) (protocol \(protocolVersion))")
      return
    }
    if arguments == ["--self-test"] { return selfTest(interfaces) }
    if arguments == ["--self-test", "changed-interface"] { return selfTest(changedInterfaces()) }
    if arguments == ["--self-test", "protocol"] {
      let output = Output()
      let slot = HandlerSlot()
      slot.set(ProtocolProbe(output: output))
      startReader(slot, output)
      dispatchMain()
    }
    guard arguments.count == 2, arguments[0] == "--udid", isUDID(arguments[1]) else {
      diagnose("usage: latch-simulator --udid <UDID> | --self-test [changed-interface | protocol] | --version")
      exit(64)
    }
    let output = Output()
    let slot = HandlerSlot()
    // SIGTERM keeps its default action (exit) until the stream can stop cleanly.
    startReader(slot, output)
    let codecs = (h264: codecAvailable(kCMVideoCodecType_H264), jpeg: codecAvailable(kCMVideoCodecType_JPEG))
    let device: Device
    do {
      let developer = try developerDirectory()
      try loadCoreSimulator(developer)
      try checkInterfaces()
      device = try Device.attach(udid: arguments[1], developer: developer)
    } catch {
      let failure = error as? Unsupported ?? Unsupported(reason: "failed")
      output.send(.capabilities, capabilities(frames: .failure(failure), h264: codecs.h264, jpeg: codecs.jpeg))
      if failure.reason == "device-not-found" || failure.reason == "device-not-booted" {
        output.send(.gone, ["reason": failure.reason == "device-not-found" ? "not-found" : "shutdown"])
      }
      diagnose("frames unavailable: \(failure.reason)")
      output.finish(0)
    }
    let stream = Stream(output: output, device: device, codecs: codecs)
    output.send(.capabilities, capabilities(frames: .success(()), h264: codecs.h264, jpeg: codecs.jpeg))
    diagnose("attached")
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: stream.queue)
    terminate.setEventHandler { stream.end() }
    terminate.resume()
    signal(SIGTERM, SIG_IGN)
    stream.queue.async { stream.watchDevice() }
    slot.set(stream)
    withExtendedLifetime(terminate) { dispatchMain() }
  }

  private static func selfTest(_ list: [Interface]) {
    let frames: Result<Void, Unsupported>
    do {
      try loadCoreSimulator(try developerDirectory())
      try checkInterfaces(list)
      frames = .success(())
    } catch { frames = .failure(error as? Unsupported ?? Unsupported(reason: "failed")) }
    let table = capabilities(frames: frames, h264: codecAvailable(kCMVideoCodecType_H264), jpeg: codecAvailable(kCMVideoCodecType_JPEG))
    FileHandle.standardOutput.write(json(table) + Data("\n".utf8))
  }
}

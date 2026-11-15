// One pseudo-terminal for one shell, driven by the Host over framed stdin and stdout. The Host decides what runs, in
// which folder and with exactly which environment; this process owns the pty, relays bytes both ways and, when the Host
// closes the terminal or goes away, ends every process group on it.
//
// A frame is one type byte, the payload's length as a 4-byte big-endian integer, then the payload.
// Host to helper, on stdin: 1 start (JSON with file, argv, env, cwd, pinnedCwd, cols and rows; first and only once),
// 2 input (bytes). On fd 3, so input a program does not read cannot hold them back: 3 resize (columns and rows, 2 bytes
// each), 4 signal (1 byte: SIGHUP, SIGINT, SIGTERM or SIGKILL, for the foreground process group). The end of either
// pipe, or SIGTERM, closes the terminal.
// Helper to Host: 1 started {"pid"}, 2 output (bytes), 3 foreground {"busy","name"}, 4 exit {"code"} or {"signal"},
// 5 error {"error"}.
import CoreFoundation
import Darwin
import Foundation

private let frameLimit = 65_536
private let readSize = 16_384
/**
 * Output is sent at once after a quiet moment, so typing echoes without delay; while a program keeps writing, it goes
 * out at most every 4 ms or per 32 KiB. A pty holds only about 1 KiB, so the pty itself is always read promptly.
 */
private let coalesceNanoseconds: UInt64 = 4_000_000
private let flushBytes = 32_768
/** Output waiting for the Host beyond this stops reading the pty: programs in the terminal wait instead of Latch buffering. */
private let outputHighWater = 262_144
/** Input waiting for the pty beyond this stops reading frames: the Host's pipe fills instead. */
private let inputHighWater = 262_144
private let pathLimit = 4096
private let controlDescriptor: Int32 = 3
private let pinnedDirectory: Int32 = 4
private let variableLimit = 256
private let sizeLimit: ClosedRange<Int64> = 1...1000
private let allowedSignals: Set<Int32> = [SIGHUP, SIGINT, SIGTERM, SIGKILL]
/** Phases advance on a 50 ms tick: ten ticks of output after the shell exits, a one-second grace before SIGKILL. */
private let tickMilliseconds = 50
private let drainTicks = 10
private let graceTicks = 20
private let giveUpTicks = 40

private enum Inbound: UInt8 { case start = 1, input, resize, signal }
private enum Outbound: UInt8 { case started = 1, output, foreground, exit, error }
private enum Failure: String, Error { case invalidInput = "invalid-input", cwd, pty, exec }
private enum TimerIdent: UInt { case foreground = 1, tick, flush }
private typealias Event = kevent
private enum Phase { case running, draining, closing, killed, flushing }

private func json(_ object: [String: Any]) -> Data {
  (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
}

private func frame(_ type: Outbound, _ payload: some Collection<UInt8>) -> [UInt8] {
  let length = UInt32(payload.count)
  return [type.rawValue, UInt8(length >> 24), UInt8(length >> 16 & 0xff), UInt8(length >> 8 & 0xff), UInt8(length & 0xff)]
    + payload
}

/** Before the terminal starts stdout is still blocking: one error frame, then exit. */
private func fail(_ failure: Failure) -> Never {
  let bytes = frame(.error, json(["error": failure.rawValue]))
  bytes.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let count = Darwin.write(STDOUT_FILENO, raw.baseAddress!.advanced(by: offset), raw.count - offset)
      if count < 0 && errno == EINTR { continue }
      if count <= 0 { break }
      offset += count
    }
  }
  Darwin._exit(1)
}

private func readExactly(_ count: Int) -> [UInt8]? {
  var bytes = [UInt8](repeating: 0, count: count)
  var offset = 0
  while offset < count {
    let read = bytes.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress!.advanced(by: offset), count - offset) }
    if read < 0 && errno == EINTR { continue }
    if read <= 0 { return nil }
    offset += read
  }
  return bytes
}

private func absolute(_ path: String) -> Bool {
  path.hasPrefix("/") && path.utf8.count <= pathLimit && !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}

private func dimension(_ value: Any?) -> UInt16? {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFNumberGetTypeID(), !CFNumberIsFloatType(number),
    sizeLimit.contains(number.int64Value) else { return nil }
  return UInt16(number.int64Value)
}

private func variable(_ name: String, _ value: String) -> Bool {
  !name.isEmpty && name.utf8.count <= variableLimit && !name.utf8.contains(where: { $0 == 0 || $0 == UInt8(ascii: "=") })
    && !value.utf8.contains(0)
}

private struct Start {
  let file: String
  let argv: [String]
  /** `NAME=value`: the shell's whole environment. This process's own, which CoreFoundation adds to, is never passed on. */
  let env: [String]
  let cwd: String
  let size: winsize

  init(_ payload: [UInt8]) throws {
    guard let value = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any],
      Set(value.keys) == Set(["file", "argv", "env", "cwd", "pinnedCwd", "cols", "rows"]),
      let file = value["file"] as? String, let argv = value["argv"] as? [String], let cwd = value["cwd"] as? String,
      let env = value["env"] as? [String: String], let cols = dimension(value["cols"]), let rows = dimension(value["rows"]),
      absolute(file), absolute(cwd), (1...64).contains(argv.count), argv.allSatisfy({ !$0.utf8.contains(0) }),
      (value["pinnedCwd"] as? Bool) == true, env.count <= variableLimit, env.allSatisfy({ variable($0.key, $0.value) })
    else { throw Failure.invalidInput }
    self.file = file
    self.argv = argv
    self.env = env.map { "\($0.key)=\($0.value)" }.sorted()
    self.cwd = cwd
    size = winsize(ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0)
  }
}

/** A NULL-terminated array of C strings, made before fork and never freed. */
private func cStrings(_ values: [String]) -> UnsafeMutablePointer<UnsafeMutablePointer<CChar>?> {
  let array = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: values.count + 1)
  for (index, value) in values.enumerated() { array[index] = strdup(value) }
  array[values.count] = nil
  return array
}

/** Descriptors other than stdio close when the shell starts, whoever opened them. */
private func closeOnExec() {
  let needed = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, nil, 0)
  if needed > 0 {
    var list = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(needed) / MemoryLayout<proc_fdinfo>.stride + 16)
    let used = list.withUnsafeMutableBytes { proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
    if used > 0 {
      for item in list.prefix(Int(used) / MemoryLayout<proc_fdinfo>.stride) where item.proc_fd > STDERR_FILENO {
        _ = fcntl(item.proc_fd, F_SETFD, FD_CLOEXEC)
      }
      return
    }
  }
  for descriptor in 3..<min(getdtablesize(), 65_536) { _ = fcntl(descriptor, F_SETFD, FD_CLOEXEC) }
}

/**
 * Starts the shell on a new pty. Everything the child needs is prepared before `forkpty`: between fork and exec it only
 * makes system calls, never allocates. A close-on-exec pipe tells whether exec succeeded.
 */
private func launch(_ start: Start) throws -> (shell: pid_t, master: Int32) {
  var expected = stat()
  guard fstat(pinnedDirectory, &expected) == 0, (expected.st_mode & S_IFMT) == S_IFDIR else { throw Failure.cwd }
  let directory = open(start.cwd, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard directory >= 0 else { throw Failure.cwd }
  var actual = stat()
  guard fstat(directory, &actual) == 0, actual.st_dev == expected.st_dev, actual.st_ino == expected.st_ino else {
    close(directory)
    throw Failure.cwd
  }
  close(pinnedDirectory)
  var report: [Int32] = [-1, -1]
  guard pipe(&report) == 0 else { close(directory); throw Failure.pty }
  _ = fcntl(report[0], F_SETFD, FD_CLOEXEC)
  _ = fcntl(report[1], F_SETFD, FD_CLOEXEC)
  let file = strdup(start.file)
  let argv = cStrings(start.argv)
  let environment = cStrings(start.env)
  let reportWrite = report[1]
  var size = start.size
  var master: Int32 = -1
  closeOnExec()
  let shell = forkpty(&master, nil, nil, &size)
  if shell == 0 {
    signal(SIGHUP, SIG_DFL)
    signal(SIGINT, SIG_DFL)
    signal(SIGQUIT, SIG_DFL)
    signal(SIGPIPE, SIG_DFL)
    signal(SIGTERM, SIG_DFL)
    var empty: sigset_t = 0
    sigprocmask(SIG_SETMASK, &empty, nil)
    // forkpty ignores a failed login_tty, which would leave the Host's pipes as the shell's stdio.
    if isatty(STDIN_FILENO) == 1 && isatty(STDOUT_FILENO) == 1 && isatty(STDERR_FILENO) == 1 && fchdir(directory) == 0 {
      execve(file, argv, environment)
    }
    var code = errno
    _ = withUnsafeBytes(of: &code) { Darwin.write(reportWrite, $0.baseAddress, $0.count) }
    _exit(127)
  }
  close(report[1])
  close(directory)
  guard shell > 0 else { close(report[0]); throw Failure.pty }
  var code: Int32 = 0
  var received = 0
  while received < MemoryLayout<Int32>.size {
    let count = withUnsafeMutableBytes(of: &code) { Darwin.read(report[0], $0.baseAddress!.advanced(by: received), $0.count - received) }
    if count < 0 && errno == EINTR { continue }
    if count <= 0 { break }
    received += count
  }
  close(report[0])
  if received > 0 {
    var status: Int32 = 0
    while waitpid(shell, &status, 0) < 0 && errno == EINTR {}
    close(master)
    throw Failure.exec
  }
  return (shell, master)
}

private final class Terminal {
  private let shell: pid_t
  private var master: Int32
  private let queue: Int32
  private let device: dev_t
  private var phase = Phase.running
  private var ticks = 0
  private var status: Int32?
  private var groups = Set<pid_t>()
  private var hostGone = false
  private var protocolFailed = false
  private var inbound: [UInt8] = []
  private var controlInbound: [UInt8] = []
  private var readingControl = true
  private var input: [UInt8] = []
  private var inputStart = 0
  private var output: [UInt8] = []
  private var outputStart = 0
  private var readingFrames = true
  private var readingPty = true
  private var writingPty = false
  private var writingHost = false
  /** When the pending foreground check runs. */
  private var foregroundAt: UInt64?
  /** The last frame in `output` while it is an output frame none of which has been written: more output joins it. */
  private var openOutput: Int?
  /** A frame other than output waits: it goes out without coalescing. */
  private var urgent = false
  private var lastFlush: UInt64 = 0
  private var flushArmed = false
  private var reported: (busy: Bool, name: String)?
  private var buffer = [UInt8](repeating: 0, count: frameLimit)

  init(shell: pid_t, master: Int32) {
    self.shell = shell
    self.master = master
    queue = kqueue()
    var device: dev_t = 0
    if let name = ptsname(master) {
      var info = stat()
      if stat(name, &info) == 0 { device = info.st_rdev }
    }
    self.device = device
  }

  private var ptyOpen: Bool { master >= 0 }
  private var pendingInput: Int { input.count - inputStart }
  private var pendingOutput: Int { output.count - outputStart }

  private func change(_ ident: UInt, _ filter: Int32, _ flags: Int32, fflags: UInt32 = 0, data: Int = 0) {
    var event = Event(ident: ident, filter: Int16(filter), flags: UInt16(flags), fflags: fflags, data: data, udata: nil)
    _ = kevent(queue, &event, 1, nil, 0, nil)
  }

  private func watch(_ descriptor: Int32, _ filter: Int32, _ on: Bool) {
    change(UInt(descriptor), filter, on ? EV_ADD | EV_ENABLE : EV_DISABLE)
  }

  private func setReadingFrames(_ on: Bool) {
    guard readingFrames != on else { return }
    readingFrames = on
    watch(STDIN_FILENO, EVFILT_READ, on)
  }

  private func setReadingPty(_ on: Bool) {
    guard ptyOpen, readingPty != on else { return }
    readingPty = on
    watch(master, EVFILT_READ, on)
  }

  private func setWritingPty(_ on: Bool) {
    guard ptyOpen, writingPty != on else { return }
    writingPty = on
    watch(master, EVFILT_WRITE, on)
  }

  private func setWritingHost(_ on: Bool) {
    guard writingHost != on else { return }
    writingHost = on
    watch(STDOUT_FILENO, EVFILT_WRITE, on)
  }

  private func startTicking() {
    ticks = 0
    change(TimerIdent.tick.rawValue, EVFILT_TIMER, EV_ADD | EV_ENABLE, data: tickMilliseconds)
  }

  private func send(_ type: Outbound, _ payload: some Collection<UInt8>) {
    guard !hostGone else { return }
    if type == .output, let open = openOutput, open >= outputStart {
      let length = (Int(output[open + 1]) << 24 | Int(output[open + 2]) << 16 | Int(output[open + 3]) << 8 | Int(output[open + 4]))
        + payload.count
      if length <= frameLimit {
        output += payload
        output[open + 1] = UInt8(length >> 24)
        output[open + 2] = UInt8(length >> 16 & 0xff)
        output[open + 3] = UInt8(length >> 8 & 0xff)
        output[open + 4] = UInt8(length & 0xff)
        return
      }
    }
    openOutput = type == .output ? output.count : nil
    if type != .output { urgent = true }
    output += frame(type, payload)
  }

  /** Flushes now, or arms the flush timer for when the coalescing window ends. */
  private func flushOrWait() {
    guard pendingOutput > 0 else { return }
    let now = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    let elapsed = now &- lastFlush
    if urgent || writingHost || pendingOutput >= flushBytes || elapsed >= coalesceNanoseconds
      || phase != .running && phase != .draining {
      flush()
      lastFlush = now
      urgent = false
    } else if !flushArmed {
      flushArmed = true
      let wait = max(1, Int((coalesceNanoseconds - elapsed) / 1000))
      change(TimerIdent.flush.rawValue, EVFILT_TIMER, EV_ADD | EV_ENABLE | EV_ONESHOT, fflags: UInt32(NOTE_USECONDS), data: wait)
    }
  }

  /** Writes what it can without blocking; the rest waits for stdout to become writable. */
  private func flush() {
    while pendingOutput > 0 && !hostGone {
      let count = output.withUnsafeBytes { Darwin.write(STDOUT_FILENO, $0.baseAddress!.advanced(by: outputStart), pendingOutput) }
      if count > 0 {
        outputStart += count
      } else if count < 0 && errno == EINTR {
        continue
      } else if count < 0 && errno == EAGAIN {
        break
      } else {
        // EPIPE: the Host is gone and nobody reads what follows.
        hostGone = true
      }
    }
    if hostGone || pendingOutput == 0 {
      output.removeAll(keepingCapacity: true)
      outputStart = 0
      openOutput = nil
    } else if outputStart >= frameLimit {
      output.removeFirst(outputStart)
      openOutput = openOutput.map { $0 - outputStart }
      outputStart = 0
    }
    setWritingHost(!hostGone && pendingOutput > 0)
    if phase == .running || phase == .draining { setReadingPty(pendingOutput < outputHighWater) }
  }

  /** Checks the foreground soon after activity, every second while a program holds the terminal, else every two. */
  private func scheduleForeground(after milliseconds: Int = 100) {
    let at = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + UInt64(milliseconds) * 1_000_000
    if let pending = foregroundAt, pending <= at { return }
    foregroundAt = at
    change(TimerIdent.foreground.rawValue, EVFILT_TIMER, EV_ADD | EV_ENABLE | EV_ONESHOT, data: milliseconds)
  }

  /** Reports whether a program other than the shell has the terminal, and its name, when that changes. */
  private func checkForeground() {
    foregroundAt = nil
    guard ptyOpen, status == nil, phase == .running else { return }
    let group = tcgetpgrp(master)
    let busy = group > 1 && group != shell
    var name = ""
    if busy {
      var bytes = [CChar](repeating: 0, count: 2 * Int(MAXCOMLEN) + 1)
      if proc_name(group, &bytes, UInt32(bytes.count)) > 0 {
        name = String(decoding: bytes.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
      }
    }
    // A silent program may take the terminal long after the last activity, and closing it must still ask first.
    scheduleForeground(after: busy ? 1000 : 2000)
    if let reported, reported.busy == busy && reported.name == name { return }
    reported = (busy, name)
    send(.foreground, json(["busy": busy, "name": name]))
  }

  private func stopReadingControl() {
    guard readingControl else { return }
    readingControl = false
    watch(controlDescriptor, EVFILT_READ, false)
  }

  private func readFrames(from descriptor: Int32) {
    let control = descriptor == controlDescriptor
    let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
    if count < 0 && (errno == EAGAIN || errno == EINTR) { return }
    guard count > 0 else {
      // End of a pipe: the Host closed the terminal, or exited.
      beginClose()
      return
    }
    var pending = control ? controlInbound : inbound
    pending += buffer.prefix(count)
    var offset = 0
    while phase == .running || phase == .draining {
      guard pending.count - offset >= 5 else { break }
      let length = Int(pending[offset + 1]) << 24 | Int(pending[offset + 2]) << 16 | Int(pending[offset + 3]) << 8
        | Int(pending[offset + 4])
      guard length <= frameLimit, let type = Inbound(rawValue: pending[offset]), control == (type == .resize || type == .signal), type != .start else {
        failProtocol()
        return
      }
      guard pending.count - offset - 5 >= length else { break }
      handle(type, Array(pending[(offset + 5)..<(offset + 5 + length)]))
      offset += 5 + length
    }
    pending.removeFirst(min(offset, pending.count))
    if control { controlInbound = pending } else { inbound = pending }
  }

  private func handle(_ type: Inbound, _ payload: [UInt8]) {
    switch type {
    case .input:
      guard phase == .running, ptyOpen, status == nil else { return }
      input += payload
      writePty()
      setReadingFrames(pendingInput < inputHighWater)
      scheduleForeground()
    case .resize:
      guard payload.count == 4 else { return failProtocol() }
      let cols = Int64(payload[0]) << 8 | Int64(payload[1])
      let rows = Int64(payload[2]) << 8 | Int64(payload[3])
      guard sizeLimit.contains(cols), sizeLimit.contains(rows) else { return failProtocol() }
      guard ptyOpen else { return }
      var size = winsize(ws_row: UInt16(rows), ws_col: UInt16(cols), ws_xpixel: 0, ws_ypixel: 0)
      _ = ioctl(master, TIOCSWINSZ, &size)
    case .signal:
      guard payload.count == 1, allowedSignals.contains(Int32(payload[0])) else { return failProtocol() }
      guard ptyOpen, status == nil else { return }
      let foreground = tcgetpgrp(master)
      let group = foreground > 1 ? foreground : shell
      if group != getpgrp() { _ = killpg(group, Int32(payload[0])) }
    case .start:
      failProtocol()
    }
  }

  private func failProtocol() {
    guard !protocolFailed else { return }
    protocolFailed = true
    send(.error, json(["error": Failure.invalidInput.rawValue]))
    beginClose()
  }

  private func readPty() {
    var total = 0
    while ptyOpen && total < frameLimit {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(master, $0.baseAddress, readSize) }
      if count > 0 {
        send(.output, buffer.prefix(count))
        total += count
        continue
      }
      if count < 0 && errno == EINTR { continue }
      if count < 0 && errno == EAGAIN { break }
      // End of file or EIO: no process has the terminal open any more.
      closePty()
      if phase == .draining { finish() }
    }
    if total > 0 && phase == .running { scheduleForeground() }
  }

  private func writePty() {
    while pendingInput > 0 && ptyOpen {
      let count = input.withUnsafeBytes { Darwin.write(master, $0.baseAddress!.advanced(by: inputStart), pendingInput) }
      if count > 0 {
        inputStart += count
      } else if count < 0 && errno == EINTR {
        continue
      } else if count < 0 && errno == EAGAIN {
        break
      } else {
        // The terminal is gone; the input has nowhere to go.
        inputStart = input.count
      }
    }
    if pendingInput == 0 {
      input.removeAll(keepingCapacity: true)
      inputStart = 0
    } else if inputStart >= frameLimit {
      // What was written goes, so a long paste into a slow reader holds only what is still to be written.
      input.removeFirst(inputStart)
      inputStart = 0
    }
    setWritingPty(pendingInput > 0)
    if phase == .running { setReadingFrames(pendingInput < inputHighWater) }
  }

  private func closePty() {
    guard ptyOpen else { return }
    close(master)
    master = -1
    readingPty = false
    writingPty = false
    input.removeAll()
    inputStart = 0
  }

  private func reap() {
    guard status == nil else { return }
    var value: Int32 = 0
    let result = waitpid(shell, &value, WNOHANG)
    if result == shell {
      status = value
    } else if result < 0 && errno == ECHILD {
      status = SIGKILL
    } else {
      return
    }
    if phase == .running {
      phase = .draining
      startTicking()
    }
  }

  /**
   * The process groups on this terminal: the shell's, the foreground one, and that of every process whose controlling
   * terminal this is (a shell with job control puts each job in a group of its own). Collected while the shell still
   * leads the session; once it exits the kernel detaches the terminal from the rest.
   */
  private func collectGroups() {
    groups.insert(shell)
    if ptyOpen {
      let foreground = tcgetpgrp(master)
      if foreground > 1 { groups.insert(foreground) }
    }
    if device != 0 {
      var pids = [pid_t](repeating: 0, count: 4096)
      let bytes = pids.withUnsafeMutableBytes {
        proc_listpids(UInt32(PROC_TTY_ONLY), UInt32(bitPattern: device), $0.baseAddress, Int32($0.count))
      }
      for pid in pids.prefix(Int(max(bytes, 0)) / MemoryLayout<pid_t>.stride) where pid > 1 {
        let group = getpgid(pid)
        if group > 1 { groups.insert(group) }
      }
    }
    // Never this helper's own group, which is the Host's.
    groups.remove(getpgrp())
    groups = groups.filter { $0 > 1 }
  }

  private var groupsGone: Bool {
    groups.allSatisfy { killpg($0, 0) != 0 && errno == ESRCH }
  }

  /** The shell's own group first: it ends before it can see a job die and report that as its own exit. */
  private func signalGroups(_ number: Int32) {
    for group in [shell] + groups.subtracting([shell]) where groups.contains(group) {
      _ = killpg(group, number)
      if number == SIGHUP { _ = killpg(group, SIGCONT) }
    }
  }

  /** SIGHUP and SIGCONT to every group, then a hangup; SIGKILL follows after the grace period. */
  private func beginClose() {
    guard phase == .running || phase == .draining else { return }
    setReadingFrames(false)
    stopReadingControl()
    if status != nil {
      finish()
      return
    }
    collectGroups()
    signalGroups(SIGHUP)
    closePty()
    phase = .closing
    startTicking()
  }

  private func tick() {
    ticks += 1
    reap()
    switch phase {
    case .running:
      break
    case .draining:
      if !ptyOpen || ticks >= drainTicks { finish() }
    case .closing:
      if status != nil && groupsGone {
        finish()
      } else if ticks >= graceTicks {
        if status == nil { collectGroups() }
        signalGroups(SIGKILL)
        phase = .killed
        ticks = 0
      }
    case .killed:
      if status != nil && groupsGone || ticks >= giveUpTicks { finish() }
    case .flushing:
      if ticks >= giveUpTicks { exit(protocolFailed ? 1 : 0) }
    }
  }

  /** Reports how the shell ended once its output is drained, then exits when the Host has read it. */
  private func finish() {
    guard phase != .flushing else { return }
    closePty()
    setReadingFrames(false)
    stopReadingControl()
    phase = .flushing
    startTicking()
    let value = status ?? SIGKILL
    let report: [String: Any] = value & 0x7f == 0 ? ["code": Int(value >> 8 & 0xff)] : ["signal": Int(value & 0x7f)]
    send(.exit, json(report))
  }

  /** The terminal cannot be watched any more: end it at once rather than leave the shell behind. */
  private func abandon() -> Never {
    collectGroups()
    signalGroups(SIGKILL)
    exit(1)
  }

  func run() -> Never {
    guard queue >= 0 else { abandon() }
    for descriptor in [STDIN_FILENO, STDOUT_FILENO, controlDescriptor, master] {
      _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
    }
    change(UInt(STDIN_FILENO), EVFILT_READ, EV_ADD | EV_ENABLE)
    change(UInt(controlDescriptor), EVFILT_READ, EV_ADD | EV_ENABLE)
    change(UInt(master), EVFILT_READ, EV_ADD | EV_ENABLE)
    change(UInt(SIGTERM), EVFILT_SIGNAL, EV_ADD | EV_ENABLE)
    change(UInt(shell), EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, fflags: NOTE_EXIT)
    send(.started, json(["pid": Int(shell)]))
    // A shell that exited before its exit could be watched is found here.
    reap()
    scheduleForeground()
    var events = [Event](repeating: Event(ident: 0, filter: 0, flags: 0, fflags: 0, data: 0, udata: nil), count: 16)
    while true {
      flushOrWait()
      if hostGone && (phase == .running || phase == .draining) { beginClose() }
      if phase == .flushing && (hostGone || pendingOutput == 0) { exit(protocolFailed ? 1 : 0) }
      let count = events.withUnsafeMutableBufferPointer { kevent(queue, nil, 0, $0.baseAddress, Int32($0.count), nil) }
      if count < 0 {
        if errno == EINTR { continue }
        abandon()
      }
      for event in events.prefix(Int(count)) {
        switch Int32(event.filter) {
        case EVFILT_READ where event.ident == UInt(STDIN_FILENO):
          if readingFrames { readFrames(from: STDIN_FILENO) }
        case EVFILT_READ where event.ident == UInt(controlDescriptor):
          if readingControl { readFrames(from: controlDescriptor) }
        case EVFILT_READ:
          if ptyOpen && event.ident == UInt(master) { readPty() }
        case EVFILT_WRITE where event.ident == UInt(STDOUT_FILENO):
          break
        case EVFILT_WRITE:
          if ptyOpen && event.ident == UInt(master) { writePty() }
        case EVFILT_PROC:
          reap()
          // Exit was noted before the shell could be reaped: retry on the tick.
          if status == nil && phase == .running { startTicking() }
        case EVFILT_SIGNAL:
          beginClose()
        case EVFILT_TIMER where event.ident == TimerIdent.foreground.rawValue:
          checkForeground()
        case EVFILT_TIMER where event.ident == TimerIdent.flush.rawValue:
          flushArmed = false
        case EVFILT_TIMER:
          tick()
        default:
          break
        }
      }
    }
  }
}

@main private struct LatchTerminal {
  static func main() {
    // Only the Host's frames, its pipe closing or SIGTERM end the terminal: a Ctrl-C or hangup meant for the Host's own
    // terminal does not. The shell gets the default actions back before it starts.
    for number in [SIGHUP, SIGINT, SIGQUIT, SIGPIPE, SIGTERM] { signal(number, SIG_IGN) }
    guard let header = readExactly(5), header[0] == Inbound.start.rawValue else { fail(.invalidInput) }
    let length = Int(header[1]) << 24 | Int(header[2]) << 16 | Int(header[3]) << 8 | Int(header[4])
    guard length <= frameLimit, let payload = readExactly(length), let start = try? Start(payload) else { fail(.invalidInput) }
    do {
      let (shell, master) = try launch(start)
      Terminal(shell: shell, master: master).run()
    } catch let failure as Failure {
      fail(failure)
    } catch {
      fail(.pty)
    }
  }
}

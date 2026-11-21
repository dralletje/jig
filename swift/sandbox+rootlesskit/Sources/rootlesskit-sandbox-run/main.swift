// rootlesskit-sandbox-run [--cache <dir>] [--command] <workspace> <image> [args...]
//
// Runs <image> on <workspace> in the rootlesskit sandbox and passes on its stdout, stderr and exit
// status (128 + N for signal N; 125 when the sandbox itself fails). With --command, the arguments are
// the whole command instead of arguments to the image's entrypoint. For manual use and for the tests
// that SIGKILL a binary while it runs a sandbox.
import Dispatch
import Foundation
import SandboxRootlesskit

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

func writeAll(_ fd: Int32, _ data: Data) {
  data.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
      if n > 0 { offset += n } else if n < 0 && errno == EINTR { continue } else { break }
    }
  }
}

func fail(_ message: String) -> Never {
  writeAll(2, Data("rootlesskit-sandbox-run: \(message)\n".utf8))
  exit(125)
}

var args = Array(CommandLine.arguments.dropFirst())
var options = RootlesskitSandbox.Options()
var commandMode = false
while let first = args.first, first.hasPrefix("--") {
  args.removeFirst()
  switch first {
  case "--cache":
    guard !args.isEmpty else { fail("--cache needs a folder") }
    options.cacheRoot = URL(fileURLWithPath: args.removeFirst())
  case "--command":
    commandMode = true
  case "--":
    break
  default:
    fail("unknown option \(first)")
  }
  if first == "--" { break }
}
guard args.count >= 2 else { fail("usage: rootlesskit-sandbox-run [--cache <dir>] [--command] <workspace> <image> [args...]") }
let workspace = URL(fileURLWithPath: args[0])
let reference = args[1]
let rest = Array(args.dropFirst(2))

let sandbox = RootlesskitSandbox(options: options)
let signalQueue = DispatchQueue(label: "signals")
var sources: [any DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
  source.setEventHandler {
    sandbox.cleanup()
    _exit(128 + sig)
  }
  source.resume()
  sources.append(source)
}

do {
  let image = try sandbox.resolve(reference)
  let result =
    commandMode
    ? try sandbox.run(image, command: rest, workspace: workspace)
    : try sandbox.run(image, arguments: rest, workspace: workspace)
  writeAll(1, result.stdout)
  writeAll(2, result.stderr)
  switch result.termination {
  case .exited(let code): exit(code)
  case .signaled(let sig): exit(128 + sig)
  }
} catch {
  fail("\(error)")
}

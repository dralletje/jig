// swift-tools-version:6.0
import PackageDescription

// The child-process runner and the signal lifecycle. The module is `ChildProcess`, not `Process`, so it
// does not clash with Foundation's `Process`.
let package = Package(
  name: "process",
  products: [
    .library(name: "ChildProcess", targets: ["ChildProcess"])
  ],
  dependencies: [
    .package(path: "../report")
  ],
  targets: [
    .target(name: "ChildProcess", dependencies: [.product(name: "Report", package: "report")]),
    .testTarget(
      name: "ChildProcessTests", dependencies: ["ChildProcess", .product(name: "Report", package: "report")]),
  ]
)

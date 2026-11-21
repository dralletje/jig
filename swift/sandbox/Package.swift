// swift-tools-version:6.0
import PackageDescription

// The `Sandbox` protocol and the types its implementations share. No implementation.
let package = Package(
  name: "sandbox",
  products: [
    .library(name: "Sandbox", targets: ["Sandbox"])
  ],
  dependencies: [
    .package(path: "../report")
  ],
  targets: [
    .target(name: "Sandbox", dependencies: [.product(name: "Report", package: "report")]),
    .testTarget(name: "SandboxTests", dependencies: ["Sandbox"]),
  ]
)

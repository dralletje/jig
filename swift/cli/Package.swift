// swift-tools-version:6.0
import PackageDescription

// The `jig` executable: arguments, config, the run's flow and the choice of sandbox. Its
// `IntegrationTests` drive the built static binary with git, docker and rootlesskit.
let package = Package(
  name: "cli",
  products: [
    .executable(name: "jig", targets: ["jig"])
  ],
  dependencies: [
    .package(path: "../report"),
    .package(path: "../process"),
    .package(path: "../git"),
    .package(path: "../sandbox"),
    .package(path: "../oci"),
    .package(path: "../sandbox+docker"),
    .package(path: "../sandbox+rootlesskit"),
  ],
  targets: [
    .target(
      name: "RefactorCLI",
      dependencies: [
        .product(name: "Report", package: "report"),
        .product(name: "ChildProcess", package: "process"),
        .product(name: "Git", package: "git"),
        .product(name: "Sandbox", package: "sandbox"),
        .product(name: "OCI", package: "oci"),
        .product(name: "SandboxDocker", package: "sandbox+docker"),
        .product(name: "SandboxRootlesskit", package: "sandbox+rootlesskit"),
      ]),
    .executableTarget(
      name: "jig",
      dependencies: [
        "RefactorCLI",
        .product(name: "Report", package: "report"),
        .product(name: "ChildProcess", package: "process"),
        .product(name: "Sandbox", package: "sandbox"),
      ]),
    .testTarget(
      name: "CLITests",
      dependencies: [
        "RefactorCLI", .product(name: "Report", package: "report"), .product(name: "ChildProcess", package: "process"),
      ]),
    // End-to-end tests: they drive the built binary, git, docker and rootlesskit (each suite skipped
    // without what it needs).
    .testTarget(name: "IntegrationTests", exclude: ["probe"]),
  ]
)

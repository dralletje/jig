// swift-tools-version:6.0
import PackageDescription

// `RootlesskitSandbox`: the `Sandbox` that runs an action image as a direct child of the binary, with
// rootlesskit and namespaces, without a daemon.
let package = Package(
  name: "sandbox+rootlesskit",
  products: [
    .library(name: "SandboxRootlesskit", targets: ["SandboxRootlesskit"]),
    .executable(name: "rootlesskit-sandbox-run", targets: ["rootlesskit-sandbox-run"]),
  ],
  dependencies: [
    .package(path: "../report"),
    .package(path: "../process"),
    .package(path: "../sandbox"),
    .package(path: "../docker"),
    .package(path: "../oci"),
  ],
  targets: [
    // The in-sandbox init (namespaces, pivot_root, capabilities, seccomp), in C: it runs from a
    // constructor before the Swift runtime, while the process is still single-threaded.
    .target(name: "CSandboxInit"),
    .target(
      name: "SandboxRootlesskit",
      dependencies: [
        "CSandboxInit",
        .product(name: "Report", package: "report"),
        .product(name: "ChildProcess", package: "process"),
        .product(name: "Sandbox", package: "sandbox"),
        .product(name: "Docker", package: "docker"),
        .product(name: "OCI", package: "oci"),
      ]),
    // A small command line front end: manual use, and the process the SIGKILL tests kill.
    .executableTarget(
      name: "rootlesskit-sandbox-run",
      dependencies: ["SandboxRootlesskit", .product(name: "Sandbox", package: "sandbox")]),
    .testTarget(
      name: "SandboxRootlesskitTests",
      dependencies: [
        "SandboxRootlesskit", .product(name: "Report", package: "report"), .product(name: "Sandbox", package: "sandbox"),
        .product(name: "OCI", package: "oci"),
      ]),
    // Real rootlesskit + docker images: parity with docker, escape tests, SIGKILL tests (skipped
    // without rootlesskit, docker or the images).
    .testTarget(
      name: "SandboxRootlesskitIntegrationTests",
      dependencies: [
        "SandboxRootlesskit", "rootlesskit-sandbox-run", .product(name: "Report", package: "report"),
        .product(name: "Sandbox", package: "sandbox"),
      ],
      exclude: ["probe"]
    ),
  ]
)

// swift-tools-version:6.0
import PackageDescription

// `DockerSandbox`: the `Sandbox` that runs the image with `docker run`; registry images are loaded into
// Docker from jig's image store.
let package = Package(
  name: "sandbox+docker",
  products: [
    .library(name: "SandboxDocker", targets: ["SandboxDocker"])
  ],
  dependencies: [
    .package(path: "../report"),
    .package(path: "../process"),
    .package(path: "../sandbox"),
    .package(path: "../docker"),
    .package(path: "../oci"),
  ],
  targets: [
    .target(
      name: "SandboxDocker",
      dependencies: [
        .product(name: "Report", package: "report"),
        .product(name: "ChildProcess", package: "process"),
        .product(name: "Sandbox", package: "sandbox"),
        .product(name: "Docker", package: "docker"),
        .product(name: "OCI", package: "oci"),
      ]),
    .testTarget(
      name: "SandboxDockerTests",
      dependencies: [
        "SandboxDocker",
        .product(name: "Report", package: "report"),
        .product(name: "ChildProcess", package: "process"),
        .product(name: "Sandbox", package: "sandbox"),
        .product(name: "OCI", package: "oci"),
      ]),
  ]
)

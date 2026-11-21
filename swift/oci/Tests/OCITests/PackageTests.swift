import CZlib
import Testing

@testable import OCI

@Test func zlibLinks() {
  #expect(String(cString: zlibVersion()).hasPrefix("1."))
}

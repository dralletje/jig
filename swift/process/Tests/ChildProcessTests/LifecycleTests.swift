import Testing

@testable import ChildProcess

#if canImport(Glibc)
  import Glibc
#endif

// MARK: - Interruption

@Test func interruptionStopsAtOnceOutsideTheMerge() {
  var state = InterruptState()
  let first = state.signal(SIGINT)
  #expect(first == .stop)
  #expect(state.phase == .stopping)
  #expect(!state.mayStartProcesses)
  let second = state.signal(SIGTERM)
  #expect(second == .ignore)
  let merge = state.enterMerge()
  #expect(!merge)
  let finished = state.finish()
  #expect(!finished)
}

@Test func interruptionDuringTheMergeWaitsForIt() {
  var state = InterruptState()
  let merge = state.enterMerge()
  #expect(merge)
  #expect(state.mayStartProcesses)
  let first = state.signal(SIGTERM)
  let second = state.signal(SIGINT)
  #expect(first == .wait && second == .wait)
  let pending = state.leaveMerge()
  #expect(pending == SIGTERM)  // the first one counts
  #expect(state.phase == .stopping)
  let finished = state.finish()
  #expect(!finished)
}

@Test func aMergeWithoutInterruptionCarriesOn() {
  var state = InterruptState()
  let merge = state.enterMerge()
  #expect(merge)
  let pending = state.leaveMerge()
  #expect(pending == nil)
  #expect(state.phase == .running)
  let finished = state.finish()
  #expect(finished)
  let late = state.signal(SIGINT)
  #expect(late == .ignore)
}

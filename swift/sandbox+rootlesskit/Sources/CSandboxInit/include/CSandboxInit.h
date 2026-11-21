#ifndef CSANDBOXINIT_H
#define CSANDBOXINIT_H

/// The hidden first argument that turns a process into the sandbox init (see sandbox_init.c). The
/// Swift side puts it right after the executable path when it asks rootlesskit to run the binary.
#define RC_SANDBOX_INIT_MARKER "__jig-sandbox-init-v1"

/// The hidden first argument of the launcher: arm PDEATHSIG, check the parent, exec rootlesskit.
#define RC_SANDBOX_LAUNCH_MARKER "__jig-sandbox-launch-v1"

/// Returns the version of the in-sandbox init protocol (1). Referencing it from Swift is what keeps
/// the object file, and with it the constructor that runs the init, linked into the binary.
int rc_sandbox_init_protocol_version(void);

/// pipe2(fds, O_CLOEXEC): both ends close-on-exec from the start, so a process spawned concurrently on
/// another thread never inherits them (Swift's Glibc module does not export pipe2).
int rc_pipe_cloexec(int fds[2]);

/// Whether the child `pid` has exited, without reaping it (waitid with WEXITED | WNOWAIT): 1 when it
/// has (it stays a zombie, so its PID and process group ID cannot be reused yet), 0 when it still runs,
/// -1 on an error (errno). With `block`, waits until it has exited.
int rc_child_exited(int pid, int block);

#endif

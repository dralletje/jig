// The in-sandbox init of SandboxRootlesskit.
//
// The binary that links this file re-executes itself under rootlesskit with RC_SANDBOX_INIT_MARKER as
// its first argument. The constructor below sees the marker before the Swift runtime (or anything that
// could start a thread) runs, does the namespace work and never returns. Every other process returns
// from the constructor at once.
//
// Process tree inside rootlesskit (user namespace U1: rootlesskit maps the host user to 0; PID
// namespace P1, mount namespace M1; no network):
//
//   outer  (U1 root, host filesystem visible): watches the lifeline (stdin, a pipe whose write end only
//          the Swift parent holds), owns the status file in the host run directory, never enters the
//          sandbox. Not dumpable.
//   └ c1   (PID 1 of a new PID namespace P2; new mount namespace M2): builds the root (bind of the
//          image folder, /proc, /tmp, /dev, /workspace), pivot_root into it, detaches the old root,
//          then enters a nested user namespace U2 where only uid/gid <uid>/<gid> exist (mapped to U1's
//          0 = the host user), locks the mounts with another mount namespace, drops every capability
//          (bounding, ambient, inheritable, permitted, effective), sets no_new_privs and the seccomp
//          filter, and stays as the reaper of P2.
//     └ action (P2 PID 2): stdin /dev/null, cwd /workspace, execs the command with only the given env.
//
// When c1 exits, the kernel kills everything in P2. c1 dies with outer (PDEATHSIG), outer dies with
// rootlesskit's child (PDEATHSIG) and kills c1 when the lifeline closes (the Swift parent died).
//
// Arguments (after the executable and the marker):
//   <status file> <rootfs> <workspace> <uid> <gid> <hostname> <env count> <env...> <argc> <argv...>
// The status file gets one line: "exit N", "signal N" or "error <what>".

#define _GNU_SOURCE
#include "CSandboxInit.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

// The capability and seccomp/BPF kernel ABI, spelled out here: the Static Linux SDK (musl) ships no
// usable <linux/capability.h>, <linux/seccomp.h>, <linux/filter.h> or <linux/audit.h>. These values
// are fixed kernel ABI.
struct rc_cap_header {
  uint32_t version;
  int pid;
};
struct rc_cap_data {
  uint32_t effective;
  uint32_t permitted;
  uint32_t inheritable;
};
#define RC_CAPABILITY_VERSION_3 0x20080522U
struct rc_sock_filter {
  uint16_t code;
  uint8_t jt;
  uint8_t jf;
  uint32_t k;
};
struct rc_sock_fprog {
  unsigned short len;
  struct rc_sock_filter *filter;
};
struct rc_seccomp_data {
  int nr;
  uint32_t arch;
  uint64_t instruction_pointer;
  uint64_t args[6];
};
#define RC_BPF_LD_W_ABS 0x20 /* BPF_LD | BPF_W | BPF_ABS */
#define RC_BPF_JEQ_K 0x15    /* BPF_JMP | BPF_JEQ | BPF_K */
#define RC_BPF_JGE_K 0x35    /* BPF_JMP | BPF_JGE | BPF_K */
#define RC_BPF_JSET_K 0x45   /* BPF_JMP | BPF_JSET | BPF_K */
#define RC_BPF_RET_K 0x06    /* BPF_RET | BPF_K */
#define RC_STMT(code, k) ((struct rc_sock_filter){(uint16_t)(code), 0, 0, (uint32_t)(k)})
#define RC_JUMP(code, k, jt, jf) ((struct rc_sock_filter){(uint16_t)(code), (uint8_t)(jt), (uint8_t)(jf), (uint32_t)(k)})
#define RC_SECCOMP_MODE_FILTER 2
#define RC_SECCOMP_RET_KILL_PROCESS 0x80000000U
#define RC_SECCOMP_RET_ERRNO 0x00050000U
#define RC_SECCOMP_RET_ALLOW 0x7fff0000U

int rc_sandbox_init_protocol_version(void) { return 1; }

int rc_pipe_cloexec(int fds[2]) { return pipe2(fds, O_CLOEXEC); }

int rc_child_exited(int pid, int block) {
  siginfo_t info;
  memset(&info, 0, sizeof info);
  int r;
  do {
    r = waitid(P_PID, (id_t)pid, &info, WEXITED | WNOWAIT | (block ? 0 : WNOHANG));
  } while (r < 0 && errno == EINTR);
  if (r < 0) return -1;
  // With WNOHANG and no state change, waitid succeeds and leaves si_pid 0.
  return info.si_pid == pid ? 1 : 0;
}

// MARK: - Constants that older headers may lack

#ifndef PR_CAP_AMBIENT
#define PR_CAP_AMBIENT 47
#endif
#ifndef PR_CAP_AMBIENT_CLEAR_ALL
#define PR_CAP_AMBIENT_CLEAR_ALL 4
#endif
#ifndef MNT_DETACH
#define MNT_DETACH 2
#endif
#ifndef CLONE_NEWCGROUP
#define CLONE_NEWCGROUP 0x02000000
#endif
// Syscalls 424 and up have the same number on every architecture.
#ifndef __NR_open_tree
#define __NR_open_tree 428
#endif
#ifndef __NR_move_mount
#define __NR_move_mount 429
#endif
#ifndef __NR_fsopen
#define __NR_fsopen 430
#endif
#ifndef __NR_fsconfig
#define __NR_fsconfig 431
#endif
#ifndef __NR_fsmount
#define __NR_fsmount 432
#endif
#ifndef __NR_fspick
#define __NR_fspick 433
#endif
#ifndef __NR_clone3
#define __NR_clone3 435
#endif
#ifndef __NR_close_range
#define __NR_close_range 436
#endif
#ifndef __NR_pidfd_getfd
#define __NR_pidfd_getfd 438
#endif
#ifndef __NR_mount_setattr
#define __NR_mount_setattr 442
#endif
#ifndef __NR_io_uring_setup
#define __NR_io_uring_setup 425
#endif
#ifndef __NR_io_uring_enter
#define __NR_io_uring_enter 426
#endif
#ifndef __NR_io_uring_register
#define __NR_io_uring_register 427
#endif

#ifndef __NR_io_pgetevents
#if defined(__x86_64__)
#define __NR_io_pgetevents 333
#elif defined(__aarch64__)
#define __NR_io_pgetevents 292
#endif
#endif

#if defined(__x86_64__)
#define RC_AUDIT_ARCH 0xC000003EU /* AUDIT_ARCH_X86_64 */
#elif defined(__aarch64__)
#define RC_AUDIT_ARCH 0xC00000B7U /* AUDIT_ARCH_AARCH64 */
#else
#error "SandboxRootlesskit: unsupported architecture for the seccomp filter"
#endif

// Secure bits: no root semantics, no uid-change fixups, no ambient raise; all locked.
#define RC_SECUREBITS 0xEF

// MARK: - Small helpers (async-signal-safe enough for after fork)

static int status_fd = -1;  // outer: unused; c1/action: write end of the status pipe

static size_t rc_strlen(const char *s) { return strlen(s); }

static void write_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return;
    }
    buf += n;
    len -= (size_t)n;
  }
}

/// c1 and the action report a setup failure on the status pipe, then exit.
static void fail(const char *what) {
  int saved = errno;
  char line[1024];
  int n = snprintf(line, sizeof line, "error %s: %s\n", what, strerror(saved));
  if (n > 0 && status_fd >= 0) write_all(status_fd, line, (size_t)n < sizeof line ? (size_t)n : sizeof line - 1);
  _exit(126);
}

static void failx(const char *what) {
  char line[1024];
  int n = snprintf(line, sizeof line, "error %s\n", what);
  if (n > 0 && status_fd >= 0) write_all(status_fd, line, (size_t)n < sizeof line ? (size_t)n : sizeof line - 1);
  _exit(126);
}

static void path_join(char *out, size_t size, const char *a, const char *b) {
  if ((size_t)snprintf(out, size, "%s%s", a, b) >= size) {
    errno = ENAMETOOLONG;
    fail("path");
  }
}

static void close_from(int lowest) {
  if (syscall(__NR_close_range, (unsigned)lowest, ~0U, 0) == 0) return;
  for (int fd = lowest; fd < 4096; fd++) close(fd);
}

static int write_file(const char *path, const char *content) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t len = rc_strlen(content);
  ssize_t n = write(fd, content, len);
  int saved = errno;
  close(fd);
  errno = saved;
  return n == (ssize_t)len ? 0 : -1;
}

/// The mount flags of `path`'s mount that an unprivileged remount must keep (they are locked).
static unsigned long locked_flags(const char *path) {
  struct statvfs st;
  if (statvfs(path, &st) != 0) fail("statvfs");
  unsigned long flags = 0;
  if (st.f_flag & ST_NOSUID) flags |= MS_NOSUID;
  if (st.f_flag & ST_NODEV) flags |= MS_NODEV;
  if (st.f_flag & ST_NOEXEC) flags |= MS_NOEXEC;
  if (st.f_flag & ST_RDONLY) flags |= MS_RDONLY;
  return flags;
}

/// `path` must be a real directory (not a symlink): mounts follow symlinks, and the image folder is
/// not trusted to point them anywhere.
static void require_dir(const char *path) {
  struct stat st;
  if (lstat(path, &st) != 0) fail(path);
  if (!S_ISDIR(st.st_mode)) {
    errno = ENOTDIR;
    fail(path);
  }
}

// MARK: - Seccomp

struct denied {
  int nr;
  int err;
};

static void install_seccomp(void) {
  static const struct denied denied[] = {
    {__NR_mount, EPERM},
    {__NR_umount2, EPERM},
#ifdef __NR_umount
    {__NR_umount, EPERM},
#endif
    {__NR_pivot_root, EPERM},
    {__NR_chroot, EPERM},
    {__NR_unshare, EPERM},
    {__NR_setns, EPERM},
    {__NR_ptrace, EPERM},
    {__NR_process_vm_readv, EPERM},
    {__NR_process_vm_writev, EPERM},
    {__NR_kcmp, EPERM},
    {__NR_pidfd_getfd, EPERM},
    {__NR_keyctl, EPERM},
    {__NR_add_key, EPERM},
    {__NR_request_key, EPERM},
    {__NR_bpf, EPERM},
    {__NR_perf_event_open, EPERM},
    {__NR_kexec_load, EPERM},
#ifdef __NR_kexec_file_load
    {__NR_kexec_file_load, EPERM},
#endif
    {__NR_init_module, EPERM},
    {__NR_finit_module, EPERM},
    {__NR_delete_module, EPERM},
    {__NR_open_by_handle_at, EPERM},
    {__NR_name_to_handle_at, EPERM},
    {__NR_userfaultfd, EPERM},
    {__NR_open_tree, EPERM},
    {__NR_move_mount, EPERM},
    {__NR_fsopen, EPERM},
    {__NR_fsconfig, EPERM},
    {__NR_fsmount, EPERM},
    {__NR_fspick, EPERM},
    {__NR_mount_setattr, EPERM},
    {__NR_swapon, EPERM},
    {__NR_swapoff, EPERM},
    {__NR_reboot, EPERM},
    {__NR_acct, EPERM},
    {__NR_quotactl, EPERM},
    {__NR_syslog, EPERM},
    {__NR_settimeofday, EPERM},
    {__NR_clock_settime, EPERM},
    {__NR_clock_adjtime, EPERM},
    {__NR_adjtimex, EPERM},
    {__NR_vhangup, EPERM},
    {__NR_personality, EPERM},
#ifdef __NR_iopl
    {__NR_iopl, EPERM},
#endif
#ifdef __NR_ioperm
    {__NR_ioperm, EPERM},
#endif
    // clone3 passes its flags in memory a filter cannot read: ENOSYS makes libc fall back to clone.
    {__NR_clone3, ENOSYS},
    {__NR_io_uring_setup, ENOSYS},
    {__NR_io_uring_enter, ENOSYS},
    {__NR_io_uring_register, ENOSYS},
    // Linux native AIO (libaio): a large, rarely needed kernel surface. ENOSYS, as for io_uring, so a
    // program that tries it falls back to ordinary reads and writes.
    {__NR_io_setup, ENOSYS},
    {__NR_io_submit, ENOSYS},
    {__NR_io_getevents, ENOSYS},
    {__NR_io_pgetevents, ENOSYS},
    {__NR_io_cancel, ENOSYS},
    {__NR_io_destroy, ENOSYS},
  };
  enum { DENIED = sizeof denied / sizeof denied[0] };
  struct rc_sock_filter filter[8 + 2 * DENIED + 8];
  unsigned n = 0;

  filter[n++] = RC_STMT(RC_BPF_LD_W_ABS, offsetof(struct rc_seccomp_data, arch));
  filter[n++] = RC_JUMP(RC_BPF_JEQ_K, RC_AUDIT_ARCH, 1, 0);
  filter[n++] = RC_STMT(RC_BPF_RET_K, RC_SECCOMP_RET_KILL_PROCESS);
  filter[n++] = RC_STMT(RC_BPF_LD_W_ABS, offsetof(struct rc_seccomp_data, nr));
#if defined(__x86_64__)
  // The x32 ABI numbers (bit 30) would bypass every check below.
  filter[n++] = RC_JUMP(RC_BPF_JGE_K, 0x40000000U, 0, 1);
  filter[n++] = RC_STMT(RC_BPF_RET_K, RC_SECCOMP_RET_ERRNO | EPERM);
#endif
  for (unsigned i = 0; i < DENIED; i++) {
    filter[n++] = RC_JUMP(RC_BPF_JEQ_K, (unsigned)denied[i].nr, 0, 1);
    filter[n++] = RC_STMT(RC_BPF_RET_K, RC_SECCOMP_RET_ERRNO | (unsigned)denied[i].err);
  }
  // clone with any namespace flag (the low 32 bits of the flags argument) is refused.
  const unsigned ns_flags =
    CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET;
  filter[n++] = RC_JUMP(RC_BPF_JEQ_K, __NR_clone, 0, 3);
  filter[n++] = RC_STMT(RC_BPF_LD_W_ABS, offsetof(struct rc_seccomp_data, args[0]));
  filter[n++] = RC_JUMP(RC_BPF_JSET_K, ns_flags, 0, 1);
  filter[n++] = RC_STMT(RC_BPF_RET_K, RC_SECCOMP_RET_ERRNO | EPERM);
  filter[n++] = RC_STMT(RC_BPF_RET_K, RC_SECCOMP_RET_ALLOW);

  struct rc_sock_fprog prog = {.len = (unsigned short)n, .filter = filter};
  if (prctl(PR_SET_SECCOMP, RC_SECCOMP_MODE_FILTER, &prog, 0, 0) != 0) fail("seccomp");
}

// MARK: - Capabilities

static void drop_privileges(uid_t uid, gid_t gid, int last_cap) {
  if (setresgid(gid, gid, gid) != 0) fail("setresgid");
  if (setresuid(uid, uid, uid) != 0) fail("setresuid");
  if (getuid() != uid || geteuid() != uid || getgid() != gid || getegid() != gid) failx("uid/gid not as mapped");
  for (int cap = 0; cap <= last_cap; cap++) {
    if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 && errno != EINVAL) fail("drop bounding capability");
  }
  if (prctl(PR_SET_SECUREBITS, RC_SECUREBITS, 0, 0, 0) != 0) fail("securebits");
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 && errno != EINVAL) fail("clear ambient capabilities");
  struct rc_cap_header header = {.version = RC_CAPABILITY_VERSION_3, .pid = 0};
  struct rc_cap_data data[2];
  memset(data, 0, sizeof data);
  if (syscall(SYS_capset, &header, data) != 0) fail("capset");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("no_new_privs");

  // Check what the kernel now says, not what was asked.
  memset(data, 0xff, sizeof data);
  if (syscall(SYS_capget, &header, data) != 0) fail("capget");
  for (int i = 0; i < 2; i++) {
    if (data[i].effective || data[i].permitted || data[i].inheritable) failx("capabilities left after capset");
  }
  for (int cap = 0; cap <= last_cap; cap++) {
    int r = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (r != 0 && !(r < 0 && errno == EINVAL)) failx("bounding capability left");
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) failx("no_new_privs not set");
}

// MARK: - Root filesystem

static const char *const expected_mounts[] = {
  "/", "/proc", "/proc/sys", "/proc/sysrq-trigger", "/tmp", "/dev", "/dev/null", "/dev/zero",
  "/dev/urandom", "/dev/random", "/dev/shm", "/workspace",
};
enum { EXPECTED_MOUNTS = sizeof expected_mounts / sizeof expected_mounts[0] };

/// After pivot_root: the mount table must hold exactly the sandbox's own mounts, nothing of the host.
static void verify_mounts(void) {
  FILE *file = fopen("/proc/self/mountinfo", "re");
  if (!file) fail("open mountinfo");
  int seen[EXPECTED_MOUNTS] = {0};
  char line[4096];
  while (fgets(line, sizeof line, file)) {
    // Fields: id parent major:minor root mountpoint ...
    char *field = line;
    for (int i = 0; i < 4 && field; i++) {
      field = strchr(field, ' ');
      if (field) field++;
    }
    if (!field) failx("unreadable mountinfo");
    char *end = strchr(field, ' ');
    if (!end) failx("unreadable mountinfo");
    *end = '\0';
    int known = 0;
    for (int i = 0; i < EXPECTED_MOUNTS; i++) {
      if (strcmp(field, expected_mounts[i]) == 0) {
        seen[i]++;
        known = 1;
      }
    }
    if (!known) {
      char what[600];
      snprintf(what, sizeof what, "unexpected mount in the sandbox: %.500s", field);
      fclose(file);
      failx(what);
    }
  }
  fclose(file);
  for (int i = 0; i < EXPECTED_MOUNTS; i++) {
    if (seen[i] != 1) {
      char what[200];
      snprintf(what, sizeof what, "mount %s present %d times", expected_mounts[i], seen[i]);
      failx(what);
    }
  }
}

static void build_root(const char *rootfs, const char *workspace) {
  char path[PATH_MAX];
  require_dir(rootfs);
  require_dir(workspace);
  static const char *const points[] = {"/proc", "/tmp", "/dev", "/workspace"};
  for (unsigned i = 0; i < sizeof points / sizeof points[0]; i++) {
    path_join(path, sizeof path, rootfs, points[i]);
    require_dir(path);
  }

  // Nothing done here may propagate back to rootlesskit's (or the host's) mounts.
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) fail("make / private");

  // A fresh, non-recursive bind of the image folder: the new root.
  unsigned long root_locked = locked_flags(rootfs);
  if (mount(rootfs, rootfs, NULL, MS_BIND, NULL) != 0) fail("bind the image folder");

  path_join(path, sizeof path, rootfs, "/proc");
  if (mount("proc", path, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) fail("mount /proc");
  static const char *const proc_ro[] = {"/proc/sys", "/proc/sysrq-trigger"};
  for (unsigned i = 0; i < 2; i++) {
    path_join(path, sizeof path, rootfs, proc_ro[i]);
    if (mount(path, path, NULL, MS_BIND, NULL) != 0) fail("bind /proc/sys");
    if (mount(NULL, path, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0)
      fail("remount /proc/sys read-only");
  }

  path_join(path, sizeof path, rootfs, "/tmp");
  if (mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=1777") != 0) fail("mount /tmp");

  char dev[PATH_MAX];
  path_join(dev, sizeof dev, rootfs, "/dev");
  if (mount("tmpfs", dev, "tmpfs", MS_NOSUID | MS_NOEXEC, "mode=755,size=1m") != 0) fail("mount /dev");
  static const char *const nodes[] = {"/null", "/zero", "/urandom", "/random"};
  for (unsigned i = 0; i < 4; i++) {
    char source[64];
    path_join(source, sizeof source, "/dev", nodes[i]);
    path_join(path, sizeof path, dev, nodes[i]);
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0666);
    if (fd < 0) fail("create a /dev node");
    close(fd);
    if (mount(source, path, NULL, MS_BIND, NULL) != 0) fail("bind a /dev node");
  }
  static const char *const links[][2] = {
    {"/proc/self/fd", "/fd"}, {"/proc/self/fd/0", "/stdin"}, {"/proc/self/fd/1", "/stdout"}, {"/proc/self/fd/2", "/stderr"},
  };
  for (unsigned i = 0; i < 4; i++) {
    path_join(path, sizeof path, dev, links[i][1]);
    if (symlink(links[i][0], path) != 0) fail("create a /dev link");
  }
  path_join(path, sizeof path, dev, "/shm");
  if (mkdir(path, 01777) != 0) fail("create /dev/shm");
  if (mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=1777") != 0) fail("mount /dev/shm");
  if (mount(NULL, dev, NULL, MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NOEXEC, "mode=755,size=1m") != 0)
    fail("remount /dev read-only");

  path_join(path, sizeof path, rootfs, "/workspace");
  unsigned long ws_locked = locked_flags(workspace) & ~(unsigned long)MS_RDONLY;
  if (mount(workspace, path, NULL, MS_BIND, NULL) != 0) fail("bind /workspace");
  if (mount(NULL, path, NULL, MS_REMOUNT | MS_BIND | MS_NOSUID | MS_NODEV | ws_locked, NULL) != 0)
    fail("remount /workspace");

  if (mount(NULL, rootfs, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | root_locked, NULL) != 0)
    fail("remount the image read-only");

  // pivot_root(".", ".") stacks the old root on top of the new one; detaching "." then removes the
  // old root and every host mount under it from this namespace.
  if (chdir(rootfs) != 0) fail("chdir to the new root");
  if (syscall(SYS_pivot_root, ".", ".") != 0) fail("pivot_root");
  if (umount2(".", MNT_DETACH) != 0) fail("detach the old root");
  if (chdir("/") != 0) fail("chdir /");
  verify_mounts();
}

/// Enters a user namespace in which only `uid`/`gid` exist, mapped to this process's ids (the host
/// user), then a mount namespace owned by it: every mount above becomes locked (no remount read-write,
/// no unmounting to reveal what is below), even before the capabilities are dropped.
static void enter_user_namespace(uid_t uid, gid_t gid) {
  uid_t outer_uid = geteuid();
  gid_t outer_gid = getegid();
  if (unshare(CLONE_NEWUSER) != 0) fail("unshare user namespace");
  char map[64];
  if (write_file("/proc/self/setgroups", "deny") != 0) fail("setgroups deny");
  snprintf(map, sizeof map, "%u %u 1\n", (unsigned)uid, (unsigned)outer_uid);
  if (write_file("/proc/self/uid_map", map) != 0) fail("uid_map");
  snprintf(map, sizeof map, "%u %u 1\n", (unsigned)gid, (unsigned)outer_gid);
  if (write_file("/proc/self/gid_map", map) != 0) fail("gid_map");
  if (unshare(CLONE_NEWNS) != 0) fail("unshare mount namespace");
}

// MARK: - Arguments

struct config {
  const char *status_file;
  const char *rootfs;
  const char *workspace;
  uid_t uid;
  gid_t gid;
  const char *hostname;
  char **env;
  char **argv;
};

static int parse_uint(const char *s, unsigned long max, unsigned long *out) {
  if (!s || !*s) return -1;
  char *end = NULL;
  errno = 0;
  unsigned long v = strtoul(s, &end, 10);
  if (errno || *end || v > max) return -1;
  *out = v;
  return 0;
}

static int parse_config(int argc, char **argv, struct config *c) {
  // argv[0] executable, argv[1] marker.
  int i = 2;
  if (argc < i + 8) return -1;
  c->status_file = argv[i++];
  c->rootfs = argv[i++];
  c->workspace = argv[i++];
  unsigned long v;
  if (parse_uint(argv[i++], 65535, &v) != 0 || v == 0) return -1;
  c->uid = (uid_t)v;
  if (parse_uint(argv[i++], 65535, &v) != 0 || v == 0) return -1;
  c->gid = (gid_t)v;
  c->hostname = argv[i++];
  unsigned long envc;
  if (parse_uint(argv[i++], 4096, &envc) != 0 || (unsigned long)(argc - i) < envc + 1) return -1;
  c->env = calloc(envc + 1, sizeof(char *));
  if (!c->env) return -1;
  for (unsigned long k = 0; k < envc; k++) c->env[k] = argv[i++];
  unsigned long n;
  if (parse_uint(argv[i++], 4096, &n) != 0 || n == 0 || (unsigned long)(argc - i) != n) return -1;
  c->argv = calloc(n + 1, sizeof(char *));
  if (!c->argv) return -1;
  for (unsigned long k = 0; k < n; k++) c->argv[k] = argv[i++];
  if (c->rootfs[0] != '/' || c->workspace[0] != '/' || c->status_file[0] != '/') return -1;
  return 0;
}

static int read_last_cap(void) {
  int fd = open("/proc/sys/kernel/cap_last_cap", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 63;
  char buf[16] = {0};
  ssize_t n = read(fd, buf, sizeof buf - 1);
  close(fd);
  if (n <= 0) return 63;
  int v = atoi(buf);
  return v > 0 && v < 64 ? v : 63;
}

// MARK: - The action

static const char *env_get(char **env, const char *name) {
  size_t len = strlen(name);
  for (char **e = env; *e; e++) {
    if (strncmp(*e, name, len) == 0 && (*e)[len] == '=') return *e + len + 1;
  }
  return NULL;
}

/// execve of argv[0], searched on the action's PATH (not the host's) when it holds no slash.
static void exec_action(char **argv, char **env) {
  if (strchr(argv[0], '/')) {
    execve(argv[0], argv, env);
    fail(argv[0]);
  }
  const char *search = env_get(env, "PATH");
  if (!search) search = "/usr/local/bin:/usr/bin:/bin";
  int last = ENOENT;
  while (*search) {
    const char *colon = strchr(search, ':');
    size_t len = colon ? (size_t)(colon - search) : strlen(search);
    char path[PATH_MAX];
    if (len > 0 && len + 1 + strlen(argv[0]) < sizeof path) {
      memcpy(path, search, len);
      path[len] = '/';
      strcpy(path + len + 1, argv[0]);
      execve(path, argv, env);
      if (errno != ENOENT && errno != ENOTDIR) last = errno;
    }
    if (!colon) break;
    search = colon + 1;
  }
  errno = last;
  fail(argv[0]);
}

static void c1_main(const struct config *c, int last_cap, int alive_fd) {
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) fail("pdeathsig");
  // outer may have died before PDEATHSIG was armed: then the alive pipe has no writer left.
  struct pollfd alive = {.fd = alive_fd, .events = POLLIN};
  if (poll(&alive, 1, 0) > 0 && (alive.revents & (POLLHUP | POLLERR))) _exit(1);
  close(alive_fd);

  if (setgroups(0, NULL) != 0) fail("setgroups");
  if (unshare(CLONE_NEWNS) != 0) fail("unshare mount namespace");
  if (c->hostname[0] && sethostname(c->hostname, strlen(c->hostname)) != 0) fail("sethostname");
  build_root(c->rootfs, c->workspace);

  int devnull = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (devnull < 0) fail("open /dev/null");
  enter_user_namespace(c->uid, c->gid);
  struct rlimit core = {0, 0};
  setrlimit(RLIMIT_CORE, &core);
  drop_privileges(c->uid, c->gid, last_cap);
  install_seccomp();

  pid_t action = fork();
  if (action < 0) fail("fork the action");
  if (action == 0) {
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    if (dup2(devnull, 0) != 0) fail("stdin");
    if (chdir("/workspace") != 0) fail("chdir /workspace");
    exec_action(c->argv, c->env);
  }
  close(devnull);

  int ws = 0;
  for (;;) {
    pid_t p = waitpid(-1, &ws, 0);
    if (p == action) break;
    if (p < 0 && errno != EINTR) fail("wait for the action");
  }
  char line[64];
  int n;
  if (WIFEXITED(ws)) {
    n = snprintf(line, sizeof line, "exit %d\n", WEXITSTATUS(ws));
  } else if (WIFSIGNALED(ws)) {
    n = snprintf(line, sizeof line, "signal %d\n", WTERMSIG(ws));
  } else {
    n = snprintf(line, sizeof line, "error unknown wait status %d\n", ws);
  }
  write_all(status_fd, line, (size_t)n);
  // Leaving PID 1 kills whatever the action left behind.
  _exit(0);
}

static void write_status_file(const char *path, const char *record, size_t len) {
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) _exit(125);
  write_all(fd, record, len);
  fsync(fd);
  close(fd);
}

static void outer_main(int argc, char **argv) {
  close_from(3);
  struct config c;
  if (parse_config(argc, argv, &c) != 0) {
    static const char usage[] = "jig sandbox init: bad arguments\n";
    write_all(2, usage, sizeof usage - 1);
    _exit(125);
  }
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) _exit(125);
  if (getppid() == 0) _exit(125);
  // Nothing in the sandbox may open this process's /proc entries (its root is the host's).
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
  signal(SIGPIPE, SIG_IGN);
  int last_cap = read_last_cap();

  int status_pipe[2], alive_pipe[2];
  if (pipe2(status_pipe, O_CLOEXEC) != 0 || pipe2(alive_pipe, O_CLOEXEC) != 0) {
    static const char msg[] = "error pipe\n";
    write_status_file(c.status_file, msg, sizeof msg - 1);
    _exit(1);
  }
  if (unshare(CLONE_NEWPID) != 0) {
    char msg[200];
    int n = snprintf(msg, sizeof msg, "error unshare pid namespace: %s\n", strerror(errno));
    write_status_file(c.status_file, msg, (size_t)n);
    _exit(1);
  }
  pid_t child = fork();
  if (child < 0) {
    static const char msg[] = "error fork\n";
    write_status_file(c.status_file, msg, sizeof msg - 1);
    _exit(1);
  }
  if (child == 0) {
    close(status_pipe[0]);
    close(alive_pipe[1]);
    status_fd = status_pipe[1];
    c1_main(&c, last_cap, alive_pipe[0]);
    _exit(126);
  }
  close(status_pipe[1]);
  close(alive_pipe[0]);

  char record[2048];
  size_t used = 0;
  int lifeline_open = 1;
  for (;;) {
    struct pollfd fds[2] = {{.fd = status_pipe[0], .events = POLLIN}, {.fd = lifeline_open ? 0 : -1, .events = POLLIN}};
    int r = poll(fds, 2, -1);
    if (r < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (fds[1].revents) {
      char byte;
      ssize_t n = read(0, &byte, 1);
      if (n == 0 || (n < 0 && errno != EINTR && errno != EAGAIN)) {
        // The Swift parent is gone (or closed the lifeline on purpose): end the sandbox.
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        static const char msg[] = "error lifeline closed: the sandbox was killed\n";
        write_status_file(c.status_file, msg, sizeof msg - 1);
        _exit(1);
      }
    }
    if (fds[0].revents) {
      ssize_t n = read(status_pipe[0], record + used, sizeof record - 1 - used);
      if (n > 0) {
        used += (size_t)n;
        if (used >= sizeof record - 1) break;
      } else if (n == 0 || errno != EINTR) {
        break;
      }
    }
  }
  int ws = 0;
  while (waitpid(child, &ws, 0) < 0 && errno == EINTR) {
  }
  if (used == 0) {
    used = (size_t)snprintf(record, sizeof record, "error the sandbox init ended without a status (wait status %d)\n", ws);
  }
  write_status_file(c.status_file, record, used);
  _exit(0);
}

// MARK: - Entry

/// Reads this process's own argv from /proc (musl, unlike glibc, does not pass argc/argv to
/// constructors). Returns NULL unless argv[1] is the marker.
static char **read_init_argv(int *argc_out) {
  int fd = open("/proc/self/cmdline", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return NULL;
  // Cheap check first: every ordinary start of the binary stops here.
  char head[512];
  ssize_t got = read(fd, head, sizeof head);
  if (got <= 0) {
    close(fd);
    return NULL;
  }
  size_t first = strnlen(head, (size_t)got);
  size_t init_len = sizeof RC_SANDBOX_INIT_MARKER;  // with its NUL
  size_t launch_len = sizeof RC_SANDBOX_LAUNCH_MARKER;
  int is_init = first + 1 + init_len <= (size_t)got && memcmp(head + first + 1, RC_SANDBOX_INIT_MARKER, init_len) == 0;
  int is_launch =
    first + 1 + launch_len <= (size_t)got && memcmp(head + first + 1, RC_SANDBOX_LAUNCH_MARKER, launch_len) == 0;
  if (!is_init && !is_launch) {
    close(fd);
    return NULL;
  }
  size_t cap = 1 << 16, len = (size_t)got;
  char *buf = malloc(cap);
  if (!buf) _exit(125);
  memcpy(buf, head, len);
  for (;;) {
    if (len == cap) {
      if (cap > (64u << 20)) _exit(125);
      cap *= 2;
      buf = realloc(buf, cap);
      if (!buf) _exit(125);
    }
    ssize_t n = read(fd, buf + len, cap - len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    len += (size_t)n;
  }
  close(fd);
  int argc = 0;
  for (size_t i = 0; i < len; i++)
    if (buf[i] == '\0') argc++;
  char **argv = calloc((size_t)argc + 1, sizeof(char *));
  if (!argv) _exit(125);
  size_t start = 0;
  for (int k = 0; k < argc; k++) {
    argv[k] = buf + start;
    start += strlen(buf + start) + 1;
  }
  *argc_out = argc;
  return argv;
}

/// `<self> RC_SANDBOX_LAUNCH_MARKER <expected parent pid> <program> <args...>`: arms PDEATHSIG
/// (SIGKILL) and execs <program> (rootlesskit) in this same process, so rootlesskit is killed by the
/// kernel when the Swift parent (strictly: the thread that spawned it) dies, whatever runs inside.
/// The parent may have died before the signal was armed: then getppid() is no longer the expected
/// parent and we exit instead.
static void launch_main(int argc, char **argv) {
  if (argc < 4) _exit(125);
  char *end = NULL;
  long expected = strtol(argv[2], &end, 10);
  if (!end || *end || expected <= 0) _exit(125);
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) _exit(125);
  if (getppid() != (pid_t)expected) _exit(125);
  extern char **environ;
  execve(argv[3], argv + 3, environ);
  char msg[512];
  int n = snprintf(msg, sizeof msg, "jig: could not start %s: %s\n", argv[3], strerror(errno));
  if (n > 0) write_all(2, msg, (size_t)n < sizeof msg ? (size_t)n : sizeof msg - 1);
  _exit(125);
}

__attribute__((constructor(101))) static void rc_sandbox_init_constructor(void) {
  int argc = 0;
  char **argv = read_init_argv(&argc);
  if (!argv) return;
  if (strcmp(argv[1], RC_SANDBOX_LAUNCH_MARKER) == 0) launch_main(argc, argv);
  outer_main(argc, argv);
  _exit(125);
}

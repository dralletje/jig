// Escape probe for the rootlesskit sandbox tests: compiled statically with the system cc, copied into
// the workspace and run inside the sandbox. Each argument is one check, `name` or `name:arg`; each
// check prints one line `name: RESULT`, RESULT being OK (the call succeeded: an escape when the check
// is an attack) or the errno name it failed with, or a value for the information checks.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <netinet/in.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static const char *errname(int e) {
  switch (e) {
    case EPERM: return "EPERM";
    case ENOENT: return "ENOENT";
    case EACCES: return "EACCES";
    case EROFS: return "EROFS";
    case ENOSYS: return "ENOSYS";
    case EINVAL: return "EINVAL";
    case ENETUNREACH: return "ENETUNREACH";
    case ECONNREFUSED: return "ECONNREFUSED";
    case EHOSTUNREACH: return "EHOSTUNREACH";
    case ETIMEDOUT: return "ETIMEDOUT";
    case EBUSY: return "EBUSY";
    case ENOTDIR: return "ENOTDIR";
    case EEXIST: return "EEXIST";
    case EBADF: return "EBADF";
    case ESRCH: return "ESRCH";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    case EAFNOSUPPORT: return "EAFNOSUPPORT";
    default: {
      static char buf[32];
      snprintf(buf, sizeof buf, "errno%d", e);
      return buf;
    }
  }
}

static void report(const char *name, long rc) {
  if (rc < 0) printf("%s: %s\n", name, errname(errno));
  else printf("%s: OK\n", name);
  fflush(stdout);
}

static long do_connect(const char *spec) {
  char host[128];
  int port;
  if (sscanf(spec, "%127[^:]:%d", host, &port) != 2) { errno = EINVAL; return -1; }
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
  if (fd < 0) return -1;
  struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port)};
  inet_pton(AF_INET, host, &addr.sin_addr);
  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) == 0) return 0;
  if (errno != EINPROGRESS) return -1;
  struct pollfd p = {.fd = fd, .events = POLLOUT};
  if (poll(&p, 1, 3000) == 0) { errno = ETIMEDOUT; return -1; }
  int err = 0;
  socklen_t len = sizeof err;
  getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
  if (err) { errno = err; return -1; }
  return 0;
}

static long do_connect_unix(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  strncpy(addr.sun_path, path, sizeof addr.sun_path - 1);
  return connect(fd, (struct sockaddr *)&addr, sizeof addr);
}

static long do_clone_user(void) {
  // Raw clone with CLONE_NEWUSER: the child (if any) exits at once.
  long pid = syscall(SYS_clone, CLONE_NEWUSER | SIGCHLD, 0, 0, 0, 0);
  if (pid == 0) _exit(0);
  if (pid > 0) waitpid((pid_t)pid, NULL, 0);
  return pid < 0 ? -1 : 0;
}

static long do_clone3(void) {
  struct clone_args args;
  memset(&args, 0, sizeof args);
  args.flags = CLONE_NEWUSER;
  args.exit_signal = SIGCHLD;
  long pid = syscall(435, &args, sizeof args);
  if (pid == 0) _exit(0);
  if (pid > 0) waitpid((pid_t)pid, NULL, 0);
  return pid < 0 ? -1 : 0;
}

static void print_status(void) {
  FILE *f = fopen("/proc/self/status", "r");
  char line[512];
  while (f && fgets(line, sizeof line, f)) {
    if (!strncmp(line, "Uid:", 4) || !strncmp(line, "Gid:", 4) || !strncmp(line, "Cap", 3) ||
        !strncmp(line, "NoNewPrivs:", 11) || !strncmp(line, "Seccomp:", 8) || !strncmp(line, "Groups:", 7)) {
      for (char *c = line; *c; c++)
        if (*c == '\t') *c = ' ';
      printf("status: %s", line);
    }
  }
  if (f) fclose(f);
}

static void print_mounts(void) {
  FILE *f = fopen("/proc/self/mountinfo", "r");
  char line[4096];
  printf("mounts:");
  while (f && fgets(line, sizeof line, f)) {
    char *field = line;
    for (int i = 0; i < 4 && field; i++) {
      field = strchr(field, ' ');
      if (field) field++;
    }
    char *end = field ? strchr(field, ' ') : NULL;
    if (end) *end = 0;
    printf(" %s", field ? field : "?");
  }
  printf("\n");
  if (f) fclose(f);
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    char name[256];
    strncpy(name, argv[i], sizeof name - 1);
    name[sizeof name - 1] = 0;
    char *arg = strchr(name, ':');
    if (arg) *arg++ = 0;
    const char *label = argv[i];
    errno = 0;
    if (!strcmp(name, "read")) {
      int fd = open(arg, O_RDONLY);
      if (fd >= 0) {
        char buf[256] = {0};
        ssize_t n = read(fd, buf, sizeof buf - 1);
        printf("%s: OK %s\n", label, n > 0 ? buf : "");
        continue;
      }
      report(label, -1);
    } else if (!strcmp(name, "write")) {
      report(label, open(arg, O_WRONLY | O_CREAT, 0644));
    } else if (!strcmp(name, "chmod")) {
      report(label, chmod(arg, 0777));
    } else if (!strcmp(name, "unlink")) {
      report(label, unlink(arg));
    } else if (!strcmp(name, "create")) {
      int fd = open(arg, O_WRONLY | O_CREAT | O_TRUNC, 0644);
      if (fd >= 0 && write(fd, "made in the sandbox\n", 20) != 20) fd = -1;
      report(label, fd);
    } else if (!strcmp(name, "remount-root-rw")) {
      report(label, mount(NULL, "/", NULL, MS_REMOUNT | MS_BIND, NULL));
    } else if (!strcmp(name, "remount-root-rw-plain")) {
      report(label, mount(NULL, "/", NULL, MS_REMOUNT, NULL));
    } else if (!strcmp(name, "mount-tmpfs")) {
      mkdir("/tmp/m", 0755);
      report(label, mount("tmpfs", "/tmp/m", "tmpfs", 0, NULL));
    } else if (!strcmp(name, "mount-proc")) {
      mkdir("/tmp/p", 0755);
      report(label, mount("proc", "/tmp/p", "proc", 0, NULL));
    } else if (!strcmp(name, "bind-root")) {
      mkdir("/tmp/b", 0755);
      report(label, mount("/", "/tmp/b", NULL, MS_BIND | MS_REC, NULL));
    } else if (!strcmp(name, "fsopen")) {
      report(label, syscall(430, "tmpfs", 0));
    } else if (!strcmp(name, "open-tree")) {
      report(label, syscall(428, AT_FDCWD, "/", 1 /* OPEN_TREE_CLONE */));
    } else if (!strcmp(name, "umount-root")) {
      report(label, umount2("/", MNT_DETACH));
    } else if (!strcmp(name, "umount-workspace")) {
      report(label, umount2("/workspace", MNT_DETACH));
    } else if (!strcmp(name, "chroot")) {
      mkdir("/tmp/c", 0755);
      report(label, chroot("/tmp/c"));
    } else if (!strcmp(name, "chroot-escape")) {
      // The classic breakout: chroot into a subfolder while keeping a cwd outside it, then walk up.
      mkdir("/tmp/c2", 0755);
      long rc = chroot("/tmp/c2");
      if (rc == 0) {
        for (int k = 0; k < 64; k++) (void)!chdir("..");
        rc = chroot(".");
      }
      report(label, rc);
    } else if (!strcmp(name, "pivot-root")) {
      mkdir("/tmp/pr", 0755);
      report(label, syscall(SYS_pivot_root, "/tmp", "/tmp/pr"));
    } else if (!strcmp(name, "unshare-user")) {
      report(label, unshare(CLONE_NEWUSER));
    } else if (!strcmp(name, "unshare-mount")) {
      report(label, unshare(CLONE_NEWNS));
    } else if (!strcmp(name, "unshare-net")) {
      report(label, unshare(CLONE_NEWNET));
    } else if (!strcmp(name, "clone-user")) {
      report(label, do_clone_user());
    } else if (!strcmp(name, "clone3-user")) {
      report(label, do_clone3());
    } else if (!strcmp(name, "setns-user")) {
      int fd = open("/proc/self/ns/user", O_RDONLY);
      report(label, fd < 0 ? -1 : setns(fd, CLONE_NEWUSER));
    } else if (!strcmp(name, "connect")) {
      report(label, do_connect(arg));
    } else if (!strcmp(name, "connect-unix")) {
      report(label, do_connect_unix(arg));
    } else if (!strcmp(name, "ptrace-init")) {
      report(label, ptrace(PTRACE_ATTACH, 1, 0, 0));
    } else if (!strcmp(name, "setuid0")) {
      report(label, setuid(0));
    } else if (!strcmp(name, "open-by-handle")) {
      struct {
        unsigned int handle_bytes;
        int handle_type;
        unsigned char f_handle[8];
      } h = {8, 1, {2, 0, 0, 0, 0, 0, 0, 0}};
      report(label, syscall(SYS_open_by_handle_at, AT_FDCWD, &h, O_RDONLY));
    } else if (!strcmp(name, "bpf")) {
      report(label, syscall(SYS_bpf, 0, NULL, 0));
    } else if (!strcmp(name, "keyctl")) {
      report(label, syscall(SYS_keyctl, 0, 0, 0, 0, 0));
    } else if (!strcmp(name, "io-setup")) {
      // Linux native AIO (libaio's syscalls). io_setup gets a real context; on success it is destroyed.
      unsigned long ctx = 0;
      long rc = syscall(SYS_io_setup, 1, &ctx);
      int saved = errno;
      if (rc == 0) syscall(SYS_io_destroy, ctx);
      errno = saved;
      report(label, rc);
    } else if (!strcmp(name, "io-submit")) {
      report(label, syscall(SYS_io_submit, 0UL, 0L, NULL));
    } else if (!strcmp(name, "io-getevents")) {
      report(label, syscall(SYS_io_getevents, 0UL, 0L, 0L, NULL, NULL));
    } else if (!strcmp(name, "io-pgetevents")) {
      report(label, syscall(SYS_io_pgetevents, 0UL, 0L, 0L, NULL, NULL, NULL));
    } else if (!strcmp(name, "io-cancel")) {
      report(label, syscall(SYS_io_cancel, 0UL, NULL, NULL));
    } else if (!strcmp(name, "io-destroy")) {
      report(label, syscall(SYS_io_destroy, 0UL));
    } else if (!strcmp(name, "io-uring-setup")) {
      char params[120];
      memset(params, 0, sizeof params);
      report(label, syscall(425, 1, params));
    } else if (!strcmp(name, "kill-init")) {
      report(label, kill(1, SIGKILL));
    } else if (!strcmp(name, "spawn-orphan")) {
      // A background process that clears its own parent-death signal and leaves the session: only
      // the PID namespace going away can end it. Runs `sleep <arg>`.
      pid_t pid = fork();
      if (pid == 0) {
        prctl(PR_SET_PDEATHSIG, 0, 0, 0, 0);
        setsid();
        if (fork() == 0) {
          char *args[] = {"sleep", arg, NULL};
          execv("/bin/sleep", args);
          _exit(1);
        }
        _exit(0);
      }
      waitpid(pid, NULL, 0);
      report(label, pid < 0 ? -1 : 0);
    } else if (!strcmp(name, "exec-sleep")) {
      // The action itself becomes `sleep <arg>`, its parent-death signal cleared.
      prctl(PR_SET_PDEATHSIG, 0, 0, 0, 0);
      fflush(stdout);
      char *args[] = {"sleep", arg, NULL};
      execv("/bin/sleep", args);
      report(label, -1);
    } else if (!strcmp(name, "status")) {
      print_status();
    } else if (!strcmp(name, "mounts")) {
      print_mounts();
    } else if (!strcmp(name, "hostname")) {
      char h[256] = {0};
      gethostname(h, sizeof h - 1);
      printf("%s: %s\n", label, h);
    } else if (!strcmp(name, "pids")) {
      // Every process this sandbox can see.
      printf("%s:", label);
      for (int pid = 1; pid < 4194304 && pid < 100000; pid++) {
        char p[64];
        snprintf(p, sizeof p, "/proc/%d", pid);
        struct stat st;
        if (stat(p, &st) == 0) printf(" %d", pid);
      }
      printf("\n");
    } else {
      printf("%s: UNKNOWN\n", label);
    }
    fflush(stdout);
  }
  return 0;
}

# sandbox

Runs a shell command under an OS sandbox. `sandboxCommand(policy, command)` returns the argv, env and cwd to spawn, or `{ kind: "unavailable", reason, remedy }`. It never spawns anything itself. `detectSandbox()` is cached and costs one probe of about 10 ms on Linux.

## Threat model

It stops a command from:
- writing outside the writable roots, the temp directory and its own home (below), including through `..`, absolute paths, and symlinks (old ones or ones it creates);
- reading or listing hidden paths: SSH, GPG, cloud and AI-tool credentials, browser profiles, the harness's own data and config directories, and the file an access token is handed in through (`auth/handed-in.ts`), wherever it is;
- using the network when it is `off`: TCP, UDP and DNS, including loopback to the host and abstract unix sockets;
- receiving credential-looking environment variables;
- on Linux, seeing or signalling host processes, and outliving a kill of its process group.

The default policy also hides `/run/user/<uid>` and the Docker, Podman, containerd, LXD and Incus sockets. Without that, `systemd-run --user` and `curl --unix-socket /var/run/docker.sock` both escaped here with network off. A unix socket on the filesystem stays reachable through a read-only mount.

It does not stop:
- reading any file that is not hidden: source, dotfiles, `/etc`;
- anything at all on the network when it is `on`, which is unrestricted;
- other filesystem unix sockets that are not on the hidden list (Linux);
- reading a hidden file (not a hidden directory) that is replaced by a rename while the command runs (Linux): the file is covered by a mount, and the rename takes the mount away for sandboxes already running. A hidden directory stays hidden whatever is renamed inside it;
- use of CPU, memory or disk (a private `/tmp` is RAM-backed tmpfs);
- kernel exploits;
- writes inside the workspace that run later outside the sandbox: `.git/hooks`, `package.json` scripts, editor task files.

## A home of the command's own

`policy.home` (`SandboxHome`) gives the command a home directory it may write without the user's home changing. Linux only. A directory of `home.root`, a host directory, is bound at the home's path, and every entry of the user's home is bound read-only at its own name inside it. What the user has is read as before and cannot be changed, removed or replaced; what the command makes beside it lands in `home.root`. The directories in `home.shared` (the XDG base directories and what leads to them: `.cache`, `.config`, `.local`, `.local/share`, `.local/state`) are directories of `home.root` too, bound at their places whether or not the user has them, with the user's entries bound one level down, so that a program can make its own directory beside the user's. A hidden path is not bound at all: the mask covers an empty stand-in.

`home.root` holds `home` (what is bound at the home's path) and `shared/<path>` (one directory for each shared directory, its path percent-encoded). They are kept apart, and each is a mount of its own in the sandbox, for one reason: the mount points and the copies of the user's symbolic links are made by this module, outside the sandbox, with the user's rights. A directory that is a mount cannot be renamed or replaced by a command, in its own sandbox or in a concurrent one of the same session (a background command), and `home.root` itself is mounted nowhere. So those are always made in a directory whose path no command had a part in. With the shared directories as plain subdirectories of the home's, a command could rename `~/.config`, leave a link to any directory in its place, and have the next command's mount points made there.

What it does not do:
- make a directory the user already has writable. It is bound read-only as a whole, so a tool whose cache already exists in the user's home still cannot write it. That needs copy-on-write, which only an overlay gives; this uses binds alone, so that it works with bubblewrap 0.9.0, which has no overlay options. A writable root granted for such a directory is bound over it and is the user's real one;
- follow a shared directory that is a symbolic link in the user's home (`~/.config` linked into a dotfiles repository): the link is copied, and what it points to is read-only like any other entry;
- scale to a home with very many entries. bwrap reads the whole mount table after each bind, so the start of a command takes time with the square of their number: about 3 ms more for 10 entries, 15 ms for 50, 55 ms for 130 and 0.1 s for 200 on the machine this was written on. `HOME_BINDS` (200) bounds it: a shared directory whose entries no longer fit is bound read-only as a whole, and a home whose own entries do not fit is left as it is;
- exist on macOS. `sandbox-exec` restricts paths and cannot show another directory at one, so `seatbelt.ts` ignores `policy.home`. Setting `HOME` to another directory there would be a different mechanism with different results (a program that reads the home from the user database is not redirected, and the user's settings would have to be linked in), and it could not be run here.

The mount points and the copies of the user's symbolic links stay in `home.root` between commands: about one empty file or directory for each entry of the user's home, in each session's home.

What is left of the race: an entry that appears in the user's home while a command of the session is running is not a mount in that command's sandbox, so that command can replace the entry's new mount point by a link in the moment between the next command being planned and its sandbox being set up. bwrap then mounts the user's entry, read-only, where the link points, inside that sandbox only. When the entry is a file and the link names a missing path under `/oldroot` (where bwrap keeps the host while it sets up), bwrap creates an empty file at that path on the host; a link to any other missing path makes it fail, and the command does not start. It takes a new entry in the user's home at the very time a hostile command runs in the background, and works once for each such entry.

`createCommandSandbox` gives every sandboxed command of a session the home `<temp base>/<session>.home`, except where the home is, or lies in, a writable root (the working directory is the home or contains it). Nothing outside the sandbox reads that directory, so what a command writes there never runs with the user's rights.

## Platforms

| | Backend | Status |
|---|---|---|
| Linux | bubblewrap (`bwrap`) | Tested on Ubuntu 24.04 aarch64 (bubblewrap 0.9.0). Needs unprivileged user namespaces; on Ubuntu 23.10+ an AppArmor profile must grant `userns` to bwrap. Detection names the exact fix. |
| macOS | `sandbox-exec` + generated Seatbelt profile | **Untested on a real Mac.** The profile text is unit-tested. It denies by default, so a missing allowance breaks a command rather than opening a hole. No home of the command's own: the home is read-only. |
| other | none | `unavailable` |

When bwrap cannot create namespaces, nothing else works without privileges. Landlock (enabled on this kernel) has to be applied between fork and exec of the child, which JavaScript cannot do. It needs a helper binary that applies the ruleset and then execs the command, and it only restricts files and TCP: no DNS, UDP or unix-socket isolation.

## How the shell tool uses it

1. At start-up, call `detectSandbox()`. If it is unavailable, show `reason` and `remedy` once and decide whether to run unsandboxed with approval.
2. Per command: `plan = sandboxCommand(defaultPolicy({ workspace, tempRoot, homeRoot }), { shell: input.command, shellPath, cwd })`, then `Bun.spawn(plan.argv, { env: { ...plan.env, PAGER: "cat", … }, cwd: plan.cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })`. `detached` is required.
3. Output streams through unchanged: bwrap and sandbox-exec pass the file descriptors straight to the command.
4. Stopping is unchanged: SIGTERM to `-pid`, grace period, SIGKILL to `-pid`. On Linux the sandbox's supervisor ignores SIGTERM (`plan.gracefulTermination`), so the command gets its full grace period. When the command exits, or the group is SIGKILLed, the kernel kills everything left in the sandbox, including processes that called `setsid`.
5. A command killed by a signal inside bwrap is reported as exit code `128+n`, not as `signalCode`. bwrap's own setup failures exit 1 with `bwrap: …` on stderr.
6. If a command fails with `Read-only file system`, `Permission denied` or a connection error, offer an escalation: re-plan with the extra writable root or `network: { mode: "on" }`, after approval.

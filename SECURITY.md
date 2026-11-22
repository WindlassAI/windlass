# Security policy

## Supported versions

Security fixes go into the latest minor release (the newest tag on
[Releases](https://github.com/WindlassAI/windlass/releases)) and `main`. Older versions get no fixes: update to the
latest release first and check that the problem is still there.

## Report a vulnerability privately

Use [Report a vulnerability](https://github.com/WindlassAI/windlass/security/advisories/new) (the repository's
Security tab) to send the maintainer a private report. Keep vulnerability details out of public issues,
discussions and pull requests.

Include the version (`windlass --version`) or commit, the operating system and, on Linux, the bubblewrap version,
the approval mode and any configuration that matters, what you observed and what you expected, and steps to
reproduce on a machine you control. Redact tokens, keys and personal data, and do not attach real session logs:
a small hand-made project that shows the problem is enough.

## The security model in short

Before each tool call Windlass decides whether it runs, runs inside an operating-system sandbox, asks you, or is
refused. In the `ask` and `auto` modes every command runs in a sandbox (bubblewrap on Linux, Seatbelt
`sandbox-exec` on macOS) that can write only to the working directory and a session temp directory, cannot read
credential stores or the harness's own data, has no network, gets no credential-looking environment variables, and
cannot change `.git/hooks`, `.git/config` or `.windlass/`. More access is granted only when you answer a question.
Content from sources the harness does not control taints the session, and from then on anything that can send data
out asks again. `full` mode runs commands with your own permissions.

[docs/safety.md](docs/safety.md) is the full statement of what runs unasked, what the sandbox stops and what it
does not. A report is easiest to assess when it says which line of that page the behaviour breaks.

## In scope

- **Escapes from the command sandbox**, on Linux (bubblewrap) and on macOS (Seatbelt): a sandboxed command that
  writes outside the paths it may write, reads a hidden credential store or the harness's data, reaches the network
  or a local socket, sees or signals other processes, outlives being stopped, or receives an environment variable
  it should not. This includes the sandbox of programs run with `run_code`.
- **Git metadata tricks**: a way for a sandboxed command or a file edit the agent may make without asking to plant
  something that later runs outside the sandbox, through `.git/hooks`, `.git/config` or `.windlass/`, including by
  way of a linked worktree or a path that resolves somewhere other than it appears to.
- **Credential exposure**: the sign-in, a handed-in access token (`WINDLASS_ACCESS_TOKEN_FILE`) or a credential
  store reaching a sandboxed command, the session log, the model provider or the terminal where the docs say it
  does not, and secrets in a recognised format that the redaction misses.
- **Approval and taint**: a call that runs without the question the docs say it needs, an approval that covers more
  than it says (another capability, another tool, the project rather than the session), untrusted content that does
  not taint the session, or a taint that a restart, a compaction or `/undo` clears.
- **ACP host trust**: over the Agent Client Protocol, a client's declared tools or admitted messages getting more
  trust than the protocol gives them, for example a host tool's approval covering the built-in shell or commands
  without the sandbox, a host tool's call decided as if the sandbox contained it, text admitted as untrusted that
  does not taint, or a host tool's name taking the place of one of the agent's own tools.
- The release artifacts and install path in this repository: `install.sh`, `SHA256SUMS`, the npm packages and the
  release workflow.

## Out of scope

- What [docs/safety.md](docs/safety.md) already says the sandbox does not stop: reading files that are not hidden,
  damage inside the working directory, files there that run later (such as `package.json` scripts, a
  `core.hooksPath` directory or the hooks of a repository nested in the workspace), any network use once you granted it, use of CPU, memory and disk, and kernel
  exploits.
- Anything a command does in `full` mode, on a machine without a sandbox after you allowed it, or after you approved
  running it without the sandbox.
- Prompt injection that leads only to actions you approved, or that taint already flagged before asking you.
- Secrets with no recognisable format that the redaction misses; redaction limits accidents and is not a boundary.
- What a program you start Windlass from can already do with your rights, such as an ACP client running its own
  tools or reading your files directly.
- Bugs in bubblewrap, `sandbox-exec`, the operating system, OpenAI's service or the ChatGPT sign-in itself: report
  those to their maintainers, and here only how they affect Windlass.
- Advisories for dependencies that Windlass's code does not reach, and findings from scanners without a way to
  exploit them.

## What to expect

Windlass is maintained by one person, so responses are best effort. The aim is to acknowledge a report within a
week and to say within two weeks whether it is accepted and what happens next. An accepted vulnerability is fixed
in a new patch release of the latest minor version and published as a GitHub security advisory, crediting you
unless you prefer otherwise. Please give a reasonable time for a fix before disclosing publicly; the maintainer
will agree a date with you. There is no bug bounty.

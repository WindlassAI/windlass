# Changelog

All notable changes to Windlass are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (before 1.0, a minor version may break compatibility).

## [Unreleased]

### Added

- **One sign-in for several machines.** `windlass login token` prints the access token of the saved ChatGPT sign-in
  (a secret; the sign-in is refreshed first when it is due), and a `windlass` started with
  `WINDLASS_ACCESS_TOKEN_FILE` naming a file with that token runs on it instead of a saved sign-in. This is for
  processes that cannot share a data directory, such as one per sandbox, where a copied `auth.json` would sign the
  other copies out at its first refresh: the one that holds the sign-in does all the refreshing. The file is hidden
  from sandboxed commands like the saved sign-in, and the tokens in it are redacted from tool output.
  `windlass login token --valid-for <duration>` (`30m`, `1h30m`) prints a token that is good for at least that long,
  refreshing the sign-in first when the saved token has less left: run it on a timer to keep such a file fresh,
  instead of having to ask in the last five minutes of each token.

### Changed

- A sign-in failure says which one it was by a code, where a program reads it: the `code` of the failed step's
  provider error in the session's log, and `data["windlass"].code` of the error an ACP client is answered with
  (`auth_required`, `execution_failed`, `model_list_failed`). With a handed-in access token it is one of
  `handed_in_missing`, `handed_in_unreadable`, `handed_in_empty`, `handed_in_malformed`, `handed_in_expired`, or
  the new `handed_in_rejected` for a token the provider turned down, whose step error now says so in its message
  too; with a saved sign-in it is `signed_out`, the sign-in service's own code such as `invalid_grant`, or
  `network_error`. `docs/acp.md` has the table.

### Fixed

- A refresh of the sign-in that cannot reach the sign-in service (no network, a failed lookup, a broken connection)
  is a sign-in failure like any other, with the code `network_error`: `windlass login token` prints one line,
  `sign-in failed: Could not reach the sign-in service at <host>: <reason> (network_error)`, and exits with code 1,
  where it printed a stack trace. A turn that needs a refresh at such a moment is tried again and fails as a
  connection problem, not as "Signed out".

- A handed-in access token is redacted from tool output from the moment it is in the file
  `WINDLASS_ACCESS_TOKEN_FILE` names: the file is looked at each time an output is redacted. Before, a token
  written while a command ran was unknown to the redaction until the next model call, and a command that printed it
  put it in the session.

## [0.1.1] - 2026-11-13

### Changed

- The npm packages are published by the release workflow, each with a provenance statement that ties it to the
  commit and the build that made it.

## [0.1.0] - 2026-11-13

The first release: a coding agent for the terminal that signs in with a ChatGPT plan.

### Added

- **Three interfaces, one program.** `windlass` (or `wl`) is a line interface, `windlass tui` a full-screen one, and
  `windlass acp` a server for editors that speak the Agent Client Protocol. `windlass "<task>"` runs one task to the
  end without you.
- **Works in your project.** The agent reads, searches, edits files and runs commands, then runs the checks you
  configure (tests, a type check) and carries on until they pass or says which still fail.
- **Asks before what matters.** Commands run in an operating-system sandbox without network (bubblewrap on Linux,
  `sandbox-exec` on macOS); anything that needs more asks first. Secrets in tool output are redacted before the model
  sees them.
- **Undo, review and forks.** `/undo` and `/redo` take files and conversation back or forward a turn, `/diff` and
  `/review` show and comment on what a turn changed, and a session can be forked to try another way.
- **Sessions that last.** Every session is kept on your machine and can be resumed (`windlass -c`), replayed or
  exported; long sessions are compacted, and the prompt cache's share of each request is shown as you work.
- **Yours to shape.** Project instructions (`AGENTS.md`), agents, skills, slash commands, hooks, MCP servers,
  language-server diagnostics, subagents, background commands and wake-ups, opt-in memory and telemetry.
- **Executables** for Linux and macOS, x64 and arm64, with SHA-256 checksums and an install script, and on npm:
  `npm install -g windlass-agent` installs the one for your machine.

[Unreleased]: https://github.com/parthg1901/windlass/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/parthg1901/windlass/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/parthg1901/windlass/releases/tag/v0.1.0

# CLAUDE.md

@AGENTS.md

The file above is the canonical description of this repository: architecture,
commands, the worker protocol, the event contract and the conventions. Read it
first.

## Claude-specific notes

- This repository uses the superpowers workflow. Design work goes through
  `superpowers:brainstorming` and lands in `docs/superpowers/specs/`;
  implementation plans live in `docs/superpowers/plans/`. Follow the plan
  task-by-task rather than improvising.
- Tests come before implementation. See `superpowers:test-driven-development`.
- **Never pass `--author` to `git commit`.** The session's user email is not the
  identity this repository commits under; only the repo's git config is.

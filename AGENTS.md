# EvilMonkey Agent Instructions

These instructions apply to the entire repository. More-specific `AGENTS.md` files may add or refine instructions for their directories.

## Start of a Work Session

- Read this file and any applicable scoped `AGENTS.md` files before changing files.
- Read the latest entry in `docs/logs/` when one exists. Treat it as context, then verify implementation facts against the current source.
- Identify existing workspace edits before making changes. Preserve user changes and untracked files.
- The main extension source is in `violentmonkey/`; product documentation is in `docs/`; project artwork is in `img/`.

## Changelog Requirement

- At the end of every work session that changes files, add a dated entry to `docs/logs/YYYY-MM-DD.md` before handing work back.
- If that date's log already exists, append a new clearly titled entry. Never replace or remove earlier entries.
- Record a concise summary, the files changed, validation performed and its outcome, and relevant follow-up or limitations.
- If no tests or build were run, say so. Never report unrun validation as passing.
- Do not put credentials, tokens, private page data, or other secrets in logs.
- Sessions that make no file changes do not need a changelog entry.

## Repository and Tooling

- Prefix every shell command with `rtk`. Use `rtk proxy <command>` when complete raw output is needed.
- Do not append shell chains, pipes, or redirections to tool commands. Run separate commands separately.
- Read complete files when establishing facts; do not rely on filtered excerpts in place of a full-file read.
- Do not run tests unless the user asks to test or verify the implementation. When requested, start with the narrowest relevant validation and record the exact command and result in the changelog.
- Do not run destructive Git commands such as `git stash`, `git checkout`, or `git reset`. Do not delete progress or untracked files.
- Do not commit changes or create branches unless explicitly requested.
- Do not install, enable, invoke, read, or reinstall Caveman or Claude/Anthropic plugin skills, including Superpowers.

## Implementation Practices

- Make focused changes that match the existing code and build conventions. Verify behavior from source rather than relying on imported notes or assumptions.
- Preserve Violentmonkey userscript behavior and supported GM APIs when extending the extension.
- Keep Chrome MV3 as the initial target. Do not claim other-browser support until it is implemented and verified.
- Treat planned EvilMonkey agent features as planned until they exist in code. Be explicit about unsupported browser capabilities and unverified provider integrations.
- Update documentation when user-facing behavior, setup, permissions, or architecture changes.
- Keep generated build output out of source changes unless the task specifically requires packaged artifacts.

## Chrome Development Reference

The extension package declares Node.js 24 or newer and pnpm 12.4.2. Run its scripts from `violentmonkey/`:

- Development build: `pnpm dev:mv3`
- Production build: `pnpm build:mv3`

The MV3 output directory is `violentmonkey/dist-mv3/`. Rebuild after changing generated extension assets or manifest inputs before claiming the packaged extension reflects those changes.

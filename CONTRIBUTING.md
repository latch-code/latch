# Contributing to Latch

English · [简体中文](CONTRIBUTING.zh-CN.md)

Latch is maintained by one person, so review time is the bottleneck.

- **Bug fixes** with clear steps to reproduce are welcome. Send a pull request directly for a small fix. Open an issue first for a larger one.
- **Features, new Harnesses and new dependencies:** open an issue and wait for a reply before writing code. A specialised workflow may fit better as a [plugin](docs/PLUGIN-DEVELOPMENT.md).
- **Security issues:** email [nirvanaxiaojie@gmail.com](mailto:nirvanaxiaojie@gmail.com). Don't open a public issue.

## Setup

You need macOS with Node.js 24.22.1, pnpm 11.28.6 (through Corepack), Go 1.26.10 and the Xcode Command Line Tools. The unit tests also run on Linux.

```sh
corepack pnpm install
corepack pnpm exec lefthook install
```

`pnpm install` doesn't install the Git hooks, so you need the second command. The other commands are in [AGENTS.md](AGENTS.md#命令).

## Keep your own data out of it

Without explicit paths, Latch uses your real data directory, workspace and port. During development, always give it temporary ones:

```sh
export DATA=$(mktemp -d) WORK=$(mktemp -d)
pnpm build && pnpm start:demo -- --port 0 --data-dir "$DATA" --workspace "$WORK"
pnpm stop -- --data-dir "$DATA"   # from another terminal
```

`--demo` uses a simulated model. Tests use only temporary directories, a fake model and a fake ACP agent. Don't call paid models or real agent CLIs from them.

## Pull requests

- **One problem per PR.** Keep refactors and formatting in separate PRs.
- **Keep the rules** in [AGENTS.md](AGENTS.md), especially the invariants. Read the `AGENTS.md` in each directory you touch.
- **Run what your change affects.** `pnpm check -- --plan` lists the checks for your change. At least run `pnpm check:quick`.
- **Show that it works.** Say what you tested and what you saw, and include before and after screenshots for UI changes. "Tests pass" on its own isn't enough.
- **Commit titles** use Conventional Commits with the project as the scope, for example `fix(web): …` or `feat(host): …`.
- **Never include secrets** — connection codes, keys, device credentials or unchecked logs — in commits, screenshots or PR text.

Changes to dependencies, scripts, hooks, workflows or agent instructions need the owner's review (`.github/CODEOWNERS`).

By contributing, you agree that your work is released under the [MIT License](LICENSE).

# Roadmap: what is not built yet

The end goal is one CLI that takes a website from first prompt to deployed (stack, repo, domain,
VPS, CI) in minutes, built from scripts rather than around any one agent. This file lists only what
is decided or known but **not built**; done work lives in git history and
[`superpowers/specs`](superpowers/specs).

```mermaid
flowchart LR
  checks["checks<br/>built"] --> stacks["stack templates<br/>built"] --> deploy["release deploys<br/>built"]
  deploy --> new["wdk new<br/>repo, secrets, key"] --> vps["vps: entry PR, DNS, secrets, content sync<br/>open"]
```

The CLI comes last: it only orchestrates modules that already exist.

## Bootstrap CLI: the rest of `wdk new`

Built: template, git, GitHub repo, secrets, deploy key and config; idempotent re-runs. Missing:

- **vps site entry** as a PR in `~/src/vps` instead of printed text, then wait for the switch.
- **DNS** records PR in vps `tofu/dns` from `--domain`. Registrar purchase is out of scope.
- **Staging**: a `staging` branch and its own site entry and key when the site opts in.
- **First deploy**, then print the URLs.
- **Prompts** as a thin layer over the flags, if agents are not the only users.

## vps (in `~/src/vps`)

- **Secrets** through sops per site entry (Kirby license, mail credentials).
- **Content sync** (sonda's `content.just`, `docs/server-contract.md`) generalised for stateful
  stacks: pull-first, dry-run, path-scoped push, merge-only.
- **DNS** through `tofu/dns`: one record set per site, from the same site entry.

## Stacks and conventions

- **Linters per stack** (Pint/PHPStan for Kirby, Prettier/ESLint for JS), probably pinned through
  the devShell. Undecided.
- **`docs/` contracts**: which of sonda's content, CSS and server contracts are generic.
- **Fast mode** (sonda's `AGENTS.md`) as a wdk convention or a per-project one.

## Checks: deferred

- **Static JS compat audit**: `smoke` in old engines covers real breakage. Add if a project ships
  JS to engines nobody can run.
- **Pixel diffs** against an approved baseline: only the contact sheet exists.
- **Old Safari**: unreachable on current macOS; needs an old-macOS VM or a device cloud.
- **Real old Chrome**: the `exe:chrome` path is tested; point `exe:chrome:<path>` at an old binary
  if a client needs it.
- **Perf on Linux and in CI**: `cpu.js` is macOS-only, and shared runners are noise.
- **LAN gallery** of every page × variant: `perf --serve` prints URLs instead.

## Known issues

- **`freePort()` race**: a `serve-at` that keeps running after a failed bind can still fool it. A
  nonce header would close it at the cost of every stack honouring it; left as is (2026-10-12).
- **`wdk perf` on Firefox/WebKit is noisy on a machine in use**: WebKit's synthetic pointer stops
  when its window loses focus. Run perf Chrome-only until there is an unattended machine or a
  focus-independent measurement.

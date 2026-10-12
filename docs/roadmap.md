# web-dev-kit roadmap: what is not built yet

The end goal is one CLI that takes a website from first prompt to deployed (stack, repo, domain,
VPS, CI) in minutes. It is built from scripts, not around any one agent. This file tracks every
piece that is decided or known but **not specced or built**, so nothing lives only in a chat log.

Specced so far: [`2026-10-05-kit-contract-and-checks-design.md`](superpowers/specs/2026-10-05-kit-contract-and-checks-design.md)
(module 0, thin, and module 1).

Build order: **1 → 3 → 4 → 2 (more stacks) → 5.** The CLI comes last: it only orchestrates
modules that already exist.

## 0. Repo contract: what the thin version leaves out

- **Shared agent/human rules** (done: generic `AGENTS.md` in each template, Kirby rules below its `---`; a test keeps the shared part identical). Sonda's `AGENTS.md` mixes generic rules (one concern per commit,
  `just check` before commit, never commit secrets, server-owned state is untouchable, field names
  frozen) with Kirby specifics. Split it: the generic part ships in the wdk and projects point at
  it; the stack part goes with the stack adapter.
- **`docs/` contracts.** Sonda has content, CSS and server contracts. Which are generic (the server
  contract is, through the vps module) and which are per project.
- ~~**Branch and release model, written down**~~ done (reference.md "Branches and releases").
- **Fast mode** (sonda's `AGENTS.md`) as a wdk-level convention or a per-project one.

## 2. Stack adapters

Specced: `kirby`, `static`. Missing:

- **Build stacks** (Eleventy, Vite and Astro done as templates): `build` produces `dist/`, `serve-at` runs
  `wdk serve-dir dist`. dgalis.sk (Eleventy) is the first real case.
- **`nix flake init -t web-dev-kit#<stack>` templates**: done for `static`, `kirby`, `eleventy`, `vite`, `astro`
  (each ships a generic `AGENTS.md`). Kirby's template is not smoke-tested (needs a Kirby checkout).
- **Each stack declares its deploy kind** (see 3).
- Open: does a stack adapter also pin its linters (Pint/PHPStan for Kirby, Prettier/ESLint for JS)?
  Probably yes, through the devShell, but this is undecided.

## 3. Deploy (in `~/src/vps`)

Decided: the vps flake takes each project flake as an input; the project exports
`nixosModules.default`; a deploy is a lock bump plus `switch`. The first site is dgalis.sk (static,
stateless); sonda follows once that path is proven.

Missing:

- **One parametrised `site.nix`** (done for `store` sites, 2026-10-11: iloweit.sk and dgalis.sk are served from flake builds; staging opt-in not built) to replace `dgalis-sk.nix`, `sondafestival.nix` and
  `iloweit.nix`: domain(s), www redirect, Caddy vhost, TLS, the deploy user, PHP-FPM pool (Kirby),
  secrets via sops-nix, Umami site id.
- **Three deploy kinds:**
  - `store`: the build output is a Nix store path, served read-only. The target for static sites.
  - `store + state`: code in the store, mutable paths (`content/`, `media/`, sessions) in
    `/var/lib/<site>`, symlinked or configured. The target for sonda. Needs a migration from
    today's `git pull` deploy with zero content loss.
  - `pull` (today's sonda) and `rsync` (today's dgalis.sk): kept until each site moves.
- **Who triggers a deploy.** The project CI either dispatches to the vps repo, which bumps the lock
  and runs its existing CI apply, or the vps repo polls. The vps repo already has CI apply (D18) and a
  weekly flake-update job, so dispatch → lock-bump PR → auto-merge for staging is the likely shape.
- **Staging per site.** Sonda has staging on `staging` (renamed from `dev`); staging is opt-in per site (see the store-site spec).
- **Content sync** (`content.just`, `docs/server-contract.md` §11 in sonda) generalised for stateful
  stacks: pull-first, dry-run, path-scoped push, merge-only.
- **DNS** through `tofu/dns` in vps: one record set per site from the same site entry.

## 4. CI/CD

Missing (this spec only moves sonda's test job to `nix develop -c just check`):

- **Deploy trigger** (done 2026-10-11, untested live): push to `main` -> `deploy.yml` -> vps `site-update.yml` (reference.md "Deploys"). Staging deploys not built.
- **Reusable workflows in the wdk**: `check.yml` (`workflow_call`, `nix develop -c just check`, with Nix
  cache) done and shipped as a caller in each template. Missing: deploy-staging (push to `staging`), deploy-production (push to `main`, after tests pass). Projects
  keep three thin caller files.
- ~~**Nix caching in CI**~~ done: `check.yml` uses magic-nix-cache. Cachix only if that proves flaky.
- **Private-repo fetch** (decided 2026-10-11): one read-only `NIX_ACCESS_TOKEN` (reference.md "Private repos"); wired into the vps workflows and `check.yml`. Creating the PAT is a one-time manual step.
- **Deploy credentials:** which secret the project CI holds to dispatch to vps, scoped how.
- **wdk releases:** tag → each project bumps `inputs.wdk`. Whether a bot opens those PRs, like the
  vps weekly flake update.

## 5. Bootstrap CLI

Missing entirely. Its likely steps, each calling an existing module:

1. Pick stack and name → `nix flake init -t web-dev-kit#<stack>`, then `git init`.
2. `gh repo create`, then push `main` (and `staging` if the site opts in).
3. Domain → a DNS records PR in vps `tofu/dns`. Registrar purchase is out of scope unless scripted
   later.
4. A site entry PR in vps (`site.nix` instance + flake input).
5. CI secrets set through `gh secret set`.
6. First deploy to staging; print the URLs.

Open: whether it is interactive (prompts), non-interactive (flags, so any agent or script can drive
it), or both. The "no specific agent" goal argues for flags first and prompts as a thin layer on top.
Also open: idempotency, i.e. re-running it on a half-bootstrapped project.

## 1. Checks: deferred inside the specced module

- **Static JS compat audit**: `smoke` in old engines covers real breakage. Add if a project ships
  JS to engines nobody can run.
- **Pixel diffs** against an approved baseline: only the contact sheet is planned.
- **Old Safari**: unreachable on current macOS. Add an old-macOS VM or a paid device cloud if a
  client needs it.
- **Old Chrome** (e.g. 116 via Chrome for Testing): the `exe:chrome` path is tested (smoke and shots drive
  Playwright's Chromium through it, 2026-10-12). Only a real old binary is unchecked; point `exe:chrome:<path>` at one if a client needs it.
- **Perf on Linux** (`cpu.js` is macOS-only), and perf in CI: CPU on shared runners is noise, so
  this stays local unless self-hosted runners appear.
- **LAN gallery** (an index page of every page × variant): not chosen; `perf --serve` prints URLs.

## Housekeeping

- Sonda's `docs/perf.md` keeps its findings and the measurement traps; the traps live in the
  wdk's [`perf.md`](perf.md) too, because they apply to every project. Done (traps 1–10).
- Releases are tagged from `main` (fast-forwarded from `web-kit`); the nix package version now
  follows `package.json`.

## Known issues (parked at the v0.2.2 review)

- **Multi-engine smoke on Linux CI** (GitHub ubuntu runner, nix-packaged Playwright browsers;
  investigated 2026-10-10 on sonda-web PR #6):
  - Firefox: launch timed out / `newPage: browser has been closed`, `unshare(CLONE_NEWPID): EPERM`
    in its stderr. Fixed in v0.2.3–v0.2.5: sandbox off on Linux (`MOZ_DISABLE_CONTENT_SANDBOX`,
    `security.sandbox.content.level=0`), a dead browser is relaunched lazily with 3 launch tries,
    and a crash, stall or `goto` timeout retries the page once on a fresh browser. Clean since.
  - WebKit: fixed in v0.2.6. `newPage` died on every page with `Could not create EGL display:
    no supported platform available` (seen only under `DEBUG=pw:browser`): nix's WPE WebKit
    finds no EGL driver off NixOS. The dev shell now sets `__EGL_VENDOR_LIBRARY_DIRS` to Mesa's.
    The sandbox env var and the apparmor sysctl were red herrings; v0.2.9 drops the env var.
  - A fully broken engine cost 2 × 60s per page (~17 min). Since v0.2.10 `smoke` gives up on an
    engine after 3 pages in a row lose the browser and fails the rest as "not tried"; since v0.2.11
    `shots` does the same (a note under the cell) instead of aborting. wdk's own CI smokes the
    fixture in all three engines on Linux.
  - macOS (local) was never the problem: the original "flaky under Bun" note was this, not Bun.
    Unverified: trying Node instead of Bun for the Playwright side.
- **`freePort()` race.** Fixed in v0.2.11 for the real case: a serve-at that loses its port exits
  on the bind error, so an answer only counts once serve-at has outlived it 300ms. Still fooled by
  a serve-at that keeps running after a failed bind; a nonce header would close that, at the cost
  of every stack's recipe honouring it. Decided 2026-10-12: not worth that cost; left as is.
- **`wdk perf` on Firefox/WebKit is too noisy on a machine in use.** Firefox crashes mid-matrix (now
  relaunched, v0.2.8); WebKit's synthetic pointer stops when its window loses the front, so mouse
  readings collapse halfway through. sonda-web runs perf Chrome-only (2026-10-10). Fix would need
  an unattended machine or a headless measurement that does not depend on window focus.

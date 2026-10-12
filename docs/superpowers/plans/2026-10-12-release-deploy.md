# Release deploys, phase 1 (host script, `wdk deploy`, iloweit.sk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a static site deploys by streaming its build to a restricted SSH key that unpacks a release and flips a symlink (~15-60 s), proven on iloweit.sk.

**Architecture:** vps owns the host side: `scripts/site-release` (the forced command: `release`, `rollback`, `list`) and a `deployKey` option on `services.sites.<n>` that creates the user, key, dirs and a vhost on `/srv/sites/<domain>/current`. The wdk owns `wdk deploy` and a reusable `deploy.yml`. Contract between them: three verbs over SSH, a zstd tar on stdin.

**Tech Stack:** bash + GNU coreutils/tar + zstd (host script, run via nix in tests), Bun (wdk), NixOS module, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-12-release-deploy-design.md` (this repo).

**Out of scope here (later plans):** Kirby `shared/` linking and `kind = kirby`, staging entries, dgalis.sk and sonda migrations, and deleting `site-update.yml`, `VPS_MERGE_TOKEN`, `lib.buildSite`. Dropped from the spec on purpose: `wdk deploy` does not print the site URL (the host does not know it); add `deploy.url` if wanted.

## Global Constraints

- The wdk never sacrifices speed: no step may add minutes (AGENTS.md). Target push-to-live: static no-build ~15 s, built < 60 s, rollback ~1-2 s.
- `<sha>` must match `^[0-9a-f]{7,40}$`; the deploy key is `restrict` and not root; keep 5 releases.
- Errors say what to do next. Short output. wdk: `just check` passes before every commit; conventional commits, one concern per commit; work on `web-kit`. vps: its own conventions (scripts/test-*.sh).
- Stage explicit paths; never `git commit -a` (the user edits sibling repos live). Never touch `~/src/sonda-web`.
- Config: wdk.config.js unknown keys fail with the expected ones (existing behaviour).

## Review Focus

- Path traversal in the tar (`../escape/x`): must not write outside the release dir (Task 1 test).
- Rollback with no previous release: clear error, current unchanged (Task 1 test).
- `rollback --if-current X` when a newer release is live: no-op, exit 0 (Task 1 test).
- A release whose sha already exists (redeploy same commit): replaced, flip still atomic (Task 1 test).
- Missing host / missing `dist` / not a git repo: one-line fix-it errors (Task 3 tests).
- ssh failure: message names the key/site fix, exit non-zero (Task 3 test).

---

### Task 1: `site-release` host script (vps)

**Files (repo `~/src/vps`):**
- Create: `scripts/site-release`, `scripts/test-site-release.sh`
- Modify: `justfile` (add recipe)

**Interfaces:**
- Produces: `site-release ROOT` reads `SSH_ORIGINAL_COMMAND`: `release SHA` (zstd tar on stdin), `rollback [--if-current SHA]`, `list`. Layout under ROOT: `releases/<sha>/`, `current -> releases/<sha>`, `.history` (one sha per flip).

- [ ] **Step 1: Write the test** `scripts/test-site-release.sh`:

```bash
#!/usr/bin/env bash
# Runs site-release against a temp root. Needs GNU coreutils+tar and zstd:
#   just test-site-release   (wraps this in `nix shell`)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
root=$t/site; mkdir -p "$root"
fail() { echo "FAIL: $*" >&2; exit 1; }
sr() { SSH_ORIGINAL_COMMAND="$1" bash "$here/site-release" "$root"; }
pack() { # pack DIR -> zstd tar on stdout
  tar -C "$1" -cf - . | zstd -q
}
mk() { mkdir -p "$t/src-$1"; echo "$1" > "$t/src-$1/index.html"; }
cur() { basename "$(readlink "$root/current")"; }
sha() { printf '%s%s' "$1" "0000000" | cut -c1-40; }

a=$(sha aaaaaaa); b=$(sha bbbbbbb)
mk a; mk b
sr "release $a" < <(pack "$t/src-a") | grep -q "released $a" || fail "release a"
[ "$(cur)" = "$a" ] || fail "current is a"
[ "$(cat "$root/current/index.html")" = a ] || fail "content a"
[ "$(stat -c %a "$root/releases/$a")" = 755 ] || fail "release dir is world-readable"

# redeploy of the same sha replaces it
echo changed > "$t/src-a/index.html"
sr "release $a" < <(pack "$t/src-a") >/dev/null
[ "$(cat "$root/current/index.html")" = changed ] || fail "same sha replaced"

sr "release $b" < <(pack "$t/src-b") >/dev/null
[ "$(cur)" = "$b" ] || fail "current is b"
sr "list" | grep -q "^\* $b" || fail "list marks current"

# --if-current with a different sha is a no-op
sr "rollback --if-current $a" | grep -q "nothing to do" || fail "if-current mismatch"
[ "$(cur)" = "$b" ] || fail "no-op kept b"
sr "rollback --if-current $b" | grep -q "rolled back to $a" || fail "rollback"
[ "$(cur)" = "$a" ] || fail "current is a again"

# nothing older to roll back to
if sr "rollback" 2>"$t/err"; then fail "rollback past the first release"; fi
grep -q "nothing to roll back to" "$t/err" || fail "rollback error text"
[ "$(cur)" = "$a" ] || fail "failed rollback kept current"

# bad sha, unknown verb
if sr "release ../../etc" </dev/null 2>"$t/err"; then fail "bad sha accepted"; fi
grep -q "commit sha" "$t/err" || fail "bad sha text"
if sr "frobnicate" 2>"$t/err"; then fail "unknown verb accepted"; fi
grep -q "release SHA | rollback" "$t/err" || fail "usage text"

# path traversal in the tar stays inside the release
mkdir -p "$t/evil"; echo x > "$t/evil/file"
c=$(sha ccccccc)
sr "release $c" < <(tar -C "$t/evil" --transform 's,^,../escape/,' -cf - . | zstd -q) >/dev/null
[ ! -e "$root/escape" ] && [ ! -e "$root/releases/escape" ] || fail "tar escaped the release dir"

# prune keeps 5 and never the current one
for i in 1 2 3 4 5 6 7; do
  mk "p$i"; sr "release $(sha "d$i")" < <(pack "$t/src-p$i") >/dev/null; sleep 0.01
done
[ "$(ls "$root/releases" | wc -l)" -le 5 ] || fail "more than 5 releases kept"
[ -d "$root/releases/$(cur)" ] || fail "current was pruned"
echo "site-release: all tests pass"
```

- [ ] **Step 2: Run, expect FAIL** (script missing):
`chmod +x scripts/test-site-release.sh && nix shell nixpkgs#coreutils nixpkgs#gnutar nixpkgs#zstd -c scripts/test-site-release.sh`

- [ ] **Step 3: Write `scripts/site-release`** (no shebang: the Nix module wraps it with writeShellApplication, which adds `set -euo pipefail`; the test runs it with bash, so set it too):

```bash
# site-release ROOT: the forced command of a site's deploy key (command="site-release ROOT",restrict).
# SSH_ORIGINAL_COMMAND is one of: release SHA (zstd tar on stdin) | rollback [--if-current SHA] | list
set -euo pipefail
root=${1:?usage: site-release ROOT}
rel=$root/releases
keep=5
die() { echo "site-release: $*" >&2; exit 1; }
verb=; a=; b=
read -r verb a b <<<"${SSH_ORIGINAL_COMMAND:-}" || true
mkdir -p "$rel"; touch "$root/.history"

current() { local l; l=$(readlink "$root/current" 2>/dev/null || true); echo "${l##*/}"; }
flip() { ln -s "releases/$1" "$root/current.new"; mv -T "$root/current.new" "$root/current"; }

case "$verb" in
release)
  [[ $a =~ ^[0-9a-f]{7,40}$ ]] || die "release needs a commit sha (7-40 hex), got '$a'"
  tmp=$(mktemp -d "$rel/.incoming.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  zstd -dcq | tar -x --no-same-owner -C "$tmp"
  chmod 755 "$tmp"
  rm -rf "${rel:?}/$a"
  mv -T "$tmp" "$rel/$a"
  flip "$a"
  echo "$a" >> "$root/.history"
  cur=$(current)
  # shellcheck disable=SC2012 # names are shas
  ls -1t "$rel" | tail -n +$((keep + 1)) | while read -r d; do
    if [ "$d" != "$cur" ]; then rm -rf "${rel:?}/$d"; fi
  done
  echo "released $a"
  ;;
rollback)
  cur=$(current)
  if [ "$a" = --if-current ] && [ "$cur" != "$b" ]; then
    echo "current is $cur, not $b: nothing to do"
    exit 0
  fi
  [ "$(wc -l < "$root/.history")" -ge 2 ] || die "nothing to roll back to"
  prev=$(tail -n 2 "$root/.history" | head -n 1)
  [ -d "$rel/$prev" ] || die "release $prev was pruned; nothing to roll back to"
  flip "$prev"
  sed '$d' "$root/.history" > "$root/.history.new"
  mv "$root/.history.new" "$root/.history"
  echo "rolled back to $prev"
  ;;
list)
  cur=$(current)
  # shellcheck disable=SC2012
  ls -1t "$rel" | while read -r d; do
    if [ "$d" = "$cur" ]; then echo "* $d"; else echo "  $d"; fi
  done
  ;;
*)
  die "unknown command '$verb' (release SHA | rollback [--if-current SHA] | list)"
  ;;
esac
```

- [ ] **Step 4: Run the test, expect `site-release: all tests pass`.** Fix the script (not the test) until it does.

- [ ] **Step 5: Add to `justfile`:**

```
# site-release's tests (GNU tools from nix; macOS ships BSD ones)
test-site-release:
    nix shell nixpkgs#coreutils nixpkgs#gnutar nixpkgs#zstd -c scripts/test-site-release.sh
```
Run `just test-site-release`; expect pass.

- [ ] **Step 6: Commit** (vps): `git add scripts/site-release scripts/test-site-release.sh justfile && git commit -m "feat(site-release): host side of release deploys"`

---

### Task 2: `deployKey` on `services.sites` (vps)

**Files (`~/src/vps`):** Modify `nix/modules/site.nix`; Modify `nix/modules/iloweit.nix` (adds the option, key set in Task 6).

**Interfaces:**
- Consumes: `scripts/site-release` (Task 1).
- Produces: `services.sites.<n>.deployKey` (null or an `ssh-ed25519 AAAA…` public key string). When set: user `<slug>-deploy` (slug = domain with dots replaced by `-`), authorized key `command="${siteRelease} /srv/sites/<domain>",restrict <key>`, tmpfiles dirs `/srv/sites/<domain>` (mode 755, owned by that user) and a seed symlink `current -> ${root}` (`L`, created once), vhost `root * /srv/sites/<domain>/current`.

- [ ] **Step 1: Write the eval check.** Extend `/tmp/siteeval.nix`-style check into the repo as `scripts/test-site-module.nix` (same stub-module approach used for staging: stub `assertions`, `services.caddy.virtualHosts`, `users.users`, `systemd.tmpfiles.rules`, `environment.systemPackages`), asserting for a site with `deployKey` that the vhost text contains `/srv/sites/a.sk/current`, the user `a-sk-deploy` has the key with `restrict`, and a site without `deployKey` still serves `root`. Run `nix eval --impure --json --file scripts/test-site-module.nix`; expect FAIL (option missing).

- [ ] **Step 2: Implement** in `site.nix`: `deployKey = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };`, a `siteRelease = pkgs.writeShellApplication { name = "site-release"; runtimeInputs = with pkgs; [ coreutils gnutar zstd gnused ]; text = builtins.readFile ../../scripts/site-release; };`, then `users.users`, `users.groups`, `systemd.tmpfiles.rules` (`d /srv/sites/<d> 0755 <user> <user>`, `d …/releases 0755 <user> <user>`, `L /srv/sites/<d>/current - - - - ${site.root}`) and vhost `root * ${if site.deployKey != null then "/srv/sites/${site.domain}/current" else site.root}` through `lib.mkMerge`/`concatMapAttrs` filtered on `deployKey != null`. `shell = pkgs.bashInteractive` is not needed: `useDefaultShell = true`; the forced command runs through the user's login shell.

- [ ] **Step 3: Run the eval check, expect pass.** Then `nix eval .#nixosConfigurations.production.config.system.build.toplevel.drvPath --raw` from `nix/`; expect a drv path (iloweit has no key yet, so nothing changes in production output beyond the new option).

- [ ] **Step 4: Commit:** `git add nix/modules/site.nix scripts/test-site-module.nix && git commit -m "feat(site): release layout and restricted deploy key per site"`

---

### Task 3: `deploy` config and `wdk deploy` (wdk)

**Files (`~/src/web-dev-kit`):** Create `lib/cmd/deploy.js`, `test/deploy.test.js`; Modify `lib/config.js`, `bin/wdk.js`, `flake.nix` (add `pkgs.zstd` to the devShell packages), `test/cli.test.js` (help lists `deploy`).

**Interfaces:**
- Produces: config `deploy: { host: '', dir: 'dist', build: 'just build' }`. `wdk deploy [release|rollback|list] [--host H] [--no-build] [--if-current SHA]`. Release: runs `deploy.build` (unless `--no-build`), then `tar -C dir -cf - . | zstd -q -3 | ssh -o BatchMode=yes HOST "release SHA"`. Exit 0 ok, 2 broken setup.

- [ ] **Step 1: Write `test/deploy.test.js`.** A stub `ssh` on PATH records its last argument and the tar listing it received (`zstd -dc | tar -t`) into files; a throwaway git project with a `dist/index.html`. Tests (each `expect`s exit code and text):
  1. release with `--no-build --host x@h`: stub saw `release <40-hex of HEAD>`; listing contains `./index.html`; stdout contains `released`.
  2. runs `deploy.build` first: config `build: 'touch built'` creates the file before the ssh call.
  3. no host: exit 2, stderr `no deploy host: set deploy.host in wdk.config.js or pass --host user@host`.
  4. missing dir: exit 2, stderr names `dist` and says to run the build or set `deploy.dir`.
  5. not a git repo: exit 2, stderr `deploy names a release by commit sha`.
  6. failing ssh stub (`exit 255`): exit 1, stderr contains `deploy to x@h failed` and `deployKey`.
  7. `rollback --if-current SHA` and `list` pass through as the remote command.
  8. failing build: exit 2, stderr `build failed`.
  Run `bun test test/deploy.test.js`; expect FAIL.

- [ ] **Step 2: Implement.** `lib/config.js`: add `deploy: { host: '', dir: 'dist', build: 'just build' }` to `DEFAULTS`. `lib/cmd/deploy.js`:

```js
// wdk deploy [release|rollback|list] [--host user@host] [--no-build] [--if-current SHA]
// A release is the built site streamed to the host's restricted deploy key (vps `site-release`): ~seconds.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';

const sh = (cmd, env = {}) => Bun.spawnSync(['bash', '-o', 'pipefail', '-c', cmd], { env: { ...process.env, ...env }, stdio: ['inherit', 'inherit', 'inherit'] });

export async function run(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { host: { type: 'string' }, 'no-build': { type: 'boolean' }, 'if-current': { type: 'string' } } });
	const { deploy } = await loadConfig();
	const host = values.host || deploy.host;
	if (!host) throw new Error('no deploy host: set deploy.host in wdk.config.js or pass --host user@host');
	const [sub = 'release'] = positionals;
	if (!['release', 'rollback', 'list'].includes(sub)) throw new Error(`unknown deploy command "${sub}" (release | rollback | list)`);
	const remote = sub === 'rollback' && values['if-current'] ? `rollback --if-current ${values['if-current']}` : sub;
	let sha = '';
	if (sub === 'release') {
		sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('not a git repository with a commit: deploy names a release by commit sha');
		if (!values['no-build'] && sh(deploy.build).exitCode) throw new Error(`build failed (${deploy.build}); fix it, then deploy again`);
		if (!existsSync(deploy.dir)) throw new Error(`deploy.dir "${deploy.dir}" does not exist: run the build, or set deploy.dir in wdk.config.js`);
	}
	const cmd = sub === 'release' ? 'tar -C "$DIR" -cf - . | zstd -q -3 | ssh -o BatchMode=yes "$HOST" "release $SHA"' : 'ssh -o BatchMode=yes "$HOST" "$REMOTE"';
	const r = sh(cmd, { DIR: deploy.dir, HOST: host, SHA: sha, REMOTE: remote, COPYFILE_DISABLE: '1' });
	if (r.exitCode) {
		console.error(`wdk deploy: deploy to ${host} failed (exit ${r.exitCode}). Key rejected? Check DEPLOY_SSH_KEY and that the vps site has deployKey set to its public half.`);
		return 1;
	}
	return 0;
}
```
(Error exit 2 for the thrown ones comes from `bin/wdk.js`.) Add `'deploy'` to `COMMANDS` and a help line `deploy [rollback|list]  stream the build to the host's restricted key; rollback, list`.

- [ ] **Step 3: Run `bun test test/deploy.test.js test/cli.test.js`; expect pass.** Add `pkgs.zstd` to the devShell in `flake.nix`.

- [ ] **Step 4: `just check`, then commit:** `git add lib bin test flake.nix && git commit -m "feat: wdk deploy streams a release to the host's restricted key"`

---

### Task 4: reusable `deploy.yml`, template callers, docs (wdk)

**Files:** Modify `.github/workflows/deploy.yml`; Modify `templates/{static,vite,astro,eleventy}/.github/workflows/deploy.yml`; Modify `docs/reference.md` (Deploys section), `docs/roadmap.md`.

**Interfaces:** reusable `deploy.yml` inputs: `rollback: boolean` (default false); secrets `DEPLOY_SSH_KEY`, `DEPLOY_HOST_KEY` (a pinned `ssh-keyscan -t ed25519` line), `NIX_ACCESS_TOKEN` (optional). Expects `deploy.host` in `wdk.config.js`.

- [ ] **Step 1: Replace the reusable `deploy.yml`** (keep the old behaviour only in tags already published): checkout, determinate-nix + magic-nix-cache (same pinned SHAs as `check.yml`), write the key to `~/.ssh/id_deploy` (0600) and `DEPLOY_HOST_KEY` to `~/.ssh/known_hosts`, then `nix develop -c wdk deploy` (or `nix develop -c wdk deploy rollback --if-current ${{ github.sha }}` when `inputs.rollback`), with `-o StrictHostKeyChecking=yes -i ~/.ssh/id_deploy` supplied via `GIT_SSH`-free `~/.ssh/config` (`Host *` / `IdentityFile ~/.ssh/id_deploy` / `IdentitiesOnly yes`). Remove the staging-suffix and dispatch logic.

- [ ] **Step 2: Template callers** run `check` and `deploy` as parallel jobs on push to `main`, plus a rollback job:

```yaml
name: deploy
# Push to main: check and deploy in parallel (a hotfix never waits on browsers); a failed check rolls back.
on:
  push:
    branches: [main]
jobs:
  check:
    uses: mstcgalis/web-dev-kit/.github/workflows/check.yml@vX
    secrets:
      NIX_ACCESS_TOKEN: ${{ secrets.NIX_ACCESS_TOKEN }}
  deploy:
    uses: mstcgalis/web-dev-kit/.github/workflows/deploy.yml@vX
    secrets: inherit
  rollback:
    needs: [check, deploy]
    if: failure() && needs.deploy.result == 'success' && needs.check.result == 'failure'
    uses: mstcgalis/web-dev-kit/.github/workflows/deploy.yml@vX
    with:
      rollback: true
    secrets: inherit
```
The `@vX` stays the current pin until the release in Task 5 (then `wdk update`/`just lock-templates` re-pins). Templates also gain `deploy: { host: 'SITE-deploy@HOST', dir: 'dist' }` in their `wdk.config.js` as a commented example (Eleventy's `dir` is `_site`).

- [ ] **Step 3: Docs.** `reference.md` Deploys: replace the dispatch description with the release model (layout, three verbs, secrets, timings, `wdk deploy`, how to rollback). `roadmap.md`: mark the dispatch trigger and staging-input work superseded; add "Phase 1 built, proven on iloweit.sk" only after Task 5.

- [ ] **Step 4: `just check`; commit** `git add .github templates docs && git commit -m "feat(deploy): reusable deploy.yml runs wdk deploy; check runs in parallel"`

---

### Task 5: ship and cut iloweit.sk over (needs the user: touches production and secrets)

Stop and ask before each external action. This task changes live systems.

- [ ] **Step 1:** Release wdk: bump `package.json`, `chore(release)`, fast-forward `main`, tag (per `reference.md`). `just lock-templates`, commit.
- [ ] **Step 2 (user, manual):** `ssh-keygen -t ed25519 -N '' -f /tmp/iloweit-deploy`. Public half into `iloweit.nix` as `services.sites."iloweit.sk".deployKey`; private half into the iloweit repo secret `DEPLOY_SSH_KEY`; `ssh-keyscan -t ed25519 <host>` (compare with the host key you trust) into `DEPLOY_HOST_KEY`. Delete `/tmp/iloweit-deploy*`.
- [ ] **Step 3:** vps: commit the key, push, ship through the normal path (`gh workflow run tofu.yml --ref main`, watch it). `curl -I https://iloweit.sk` before and after: unchanged (served from the seed symlink).
- [ ] **Step 4:** iloweit repo (user's tree: check `git status` first): add `deploy` to `wdk.config.js`, replace its `deploy.yml` with the Task 4 caller at the new tag, push. Time push-to-live; target < 60 s (`gh run view` plus `curl` of a changed asset). Run `wdk deploy list`, then `wdk deploy rollback` and re-deploy to prove rollback ~1-2 s.
- [ ] **Step 5:** Record measured timings in `docs/reference.md` and the roadmap ("Phase 1 built, proven on iloweit.sk: Ns"). Next plans: Kirby + staging, dgalis.sk, sonda, then the deletions.

---

## Self-review

- Spec coverage: layout, three verbs, key restriction, `wdk deploy`, reusable `deploy.yml`, parallel checks with guarded rollback, update.yml untouched, tests, iloweit first: covered. Not in this plan (listed above): Kirby, staging, dgalis/sonda, deletions, templates' Kirby deploy. URL printing dropped, noted.
- Placeholders: `@vX` in the caller is the pin to use at that time (current tag, replaced by `wdk update`); the Task 2 module and eval check are described rather than shown in full because they depend on the exact structure of `site.nix` at execution time: the executor must read it first.
- Type consistency: the verbs and the `--if-current` flag, `deploy.{host,dir,build}`, `DEPLOY_SSH_KEY`/`DEPLOY_HOST_KEY`, `deployKey`, and `/srv/sites/<domain>` are the same in every task.

# Release deploys: one fast model for static and Kirby sites

Roadmap modules 3 and 4. **Supersedes** the `store` deploy kind (vps `2026-10-11-site-module-store-design.md`) and the
rejected `store + state` kind. Rule that decides it: the wdk never sacrifices speed (AGENTS.md).

## Why

Measured from vps run history (2026-10-11): the `store` path (site-update bump PR, then `tofu.yml` apply) is ~10 min push-to-live
at best and 45+ min at worst, after the site's own checks. Rollback repeats it. Two of three push-triggered tofu runs failed,
a third queued run silently drops the pending one, and every site push also ships unrelated merged `nix/**` infra.
Sonda's `git pull` deploy is ~20 s but is its own bespoke path.

## Goal and budget

Push to live, after the build: static ~15 s; Eleventy/Vite/Astro ~45-60 s; Kirby ~40 s; `wdk deploy` from a laptop ~5-10 s;
rollback ~1-2 s. A hotfix never waits on vps CI, tofu, or a flake update.

## Host layout (vps)

```
/srv/sites/<site>/releases/<sha>/   real dir, owned by <site>-deploy, read-only to the PHP pool
/srv/sites/<site>/current -> releases/<sha>   atomic flip: ln -s + mv -T
/srv/sites/<site>/shared/           Kirby only: content/ media/ site/{accounts,sessions,cache}
```

- Caddy serves `current` (`file_server`, or `php_fastcgi` for Kirby); the flip is live with no NixOS apply.
- `site-release` (~40 lines bash, in vps) is the forced command of a per-site key (`command="site-release <site>",restrict`,
  not root). Verbs: `release <sha>` (zstd tar on stdin; unpack; link Kirby `shared/`; flip; reload php-fpm; keep 5),
  `rollback [--if-current <sha>]`, `list`. `<sha>` must match `^[0-9a-f]{7,40}$`.
- NixOS config covers infrastructure only (users, keys, vhosts, pools, dirs) and changes only when infra changes.
- Kirby: the docroot is a real release dir (PHP `__DIR__` resolves symlinks, so symlinked code would break roots);
  `vendor/` and `kirby/` ship in the release, built in CI; no composer or git on the host, so the pull key is deleted.
  Asset `?v=` must hash file contents, not mtime. Anything Kirby writes outside `shared/` (`site/config/.license`,
  `site/languages/*.php`) is decided per site from `git status --ignored` on the server before migrating.

## wdk ships

1. `wdk deploy [--host H]`: runs `just build`, tars `deploy.dir` (from `wdk.config.js`), streams it to
   `<site>-deploy@host release $(git rev-parse HEAD)`, prints the URL. Also `wdk deploy rollback|list`.
   Errors say what to do ("key rejected: add the site in vps site.nix").
2. Reusable `deploy.yml`: checkout, `wdk deploy`. Secrets `DEPLOY_SSH_KEY`, `DEPLOY_HOST_KEY` (pinned, as sonda does).
3. Checks run in parallel with the deploy on both branches, not before it. A failed check runs
   `rollback --if-current <sha>` (never undoes a newer release). Gating production is one line (`needs: check`) at 3-5 min;
   default is not to gate.
4. Kirby template: `deploy.yml`, a `just build` that bundles `git archive` + `vendor/`, a content-hash asset helper.
5. `update.yml` (wdk pin PRs) stays and stays off the deploy path. vps `flake-update.yml` covers infrastructure only once
   sites are no longer flake inputs.

## Delete

wdk `deploy.yml`'s dispatch and the dispatch scope on `NIX_ACCESS_TOKEN`; vps `site-update.yml` and `VPS_MERGE_TOKEN`;
site flake inputs in vps and `root`/`stagingRoot` (including staging added 2026-10-12); `lib.buildSite` and `nodeModulesHash`;
the roadmap's `store`/`store + state`/`pull`/`rsync` kinds (one kind remains); sonda's git-pull key and forced command (last).
Staging is a second site entry (`staging.<domain>`, own `<site>-staging` dirs, noindex, no backup) on the same script.

## Migration order

1. vps: `site-release`, `services.sites.<n>.kind = static|kirby`, `/srv/sites` layout, shipped once through the normal tofu
   dispatch. iloweit.sk first, `current` seeded from its present store path so nothing goes dark.
2. wdk: `wdk deploy` and the new `deploy.yml`; tag; point iloweit at it; measure (target < 60 s).
3. dgalis.sk; then delete the old machinery (list above).
4. Sonda, smallest step: `current -> /srv/sonda-web`, `shared/` symlinks to its existing dirs, new deploy key, `wdk deploy`
   in parallel with Tests, rollback on failure; keep the pull key one week, then delete. Staging the same.
5. Templates get `deploy.yml` by default; the bootstrap CLI (module 5) adds the vps site entry and key.

## Tests

wdk: `wdk deploy` against a local fake host (a script standing in for `site-release` over a temp dir): release, flip,
rollback, `--if-current`, bad sha, missing key message. vps: evaluate production and playground toplevels; `site-release`
tested in a temp dir (flip is atomic, keeps 5, rejects bad sha, rollback). Real proof: iloweit.sk, timed.

## Risks

Untested here: the host script and the symlink flip; proven on iloweit.sk first. Content rollback is a snapshot restore in
every design (a revert cannot undo Panel edits or blueprint changes); take the existing backup before a Kirby release that
changes blueprints. `site/accounts` and `site/sessions` are not in today's backup targets; decide before migrating sonda.
Gives up Nix-built reproducibility and the single atomic NixOS generation; rollback is by symlink.

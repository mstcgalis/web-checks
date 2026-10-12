# Kirby release deploys: sonda-web off `git pull`

Follows [`2026-10-12-release-deploy-design.md`](2026-10-12-release-deploy-design.md) (shipped for static sites) and
replaces its Kirby notes where they differ: **no `shared/` symlinks and no php-fpm reload**. Rule that decides it: the wdk never
slows a deploy (AGENTS.md). Sonda moves to the same `wdk deploy` and the same `site-release` script as iloweit.sk and dgalis.sk;
`site-release` itself does not change.

## Budget

| Step | Target | Fails the rollout if over |
|---|---|---|
| `just build` (git archive + `composer install --no-dev`, warm cache) | ≤ 3 s | 5 s |
| local `wdk deploy` of a typical commit (build included) | ≤ 6 s | 10 s |
| CI deploy job, deploy step only | ≤ 10 s | 15 s |
| CI push-to-live (cold runner) | ≤ 60 s | 90 s |
| rollback | ≤ 2 s | 3 s |

Today's `git pull` deploy is ~20 s *after* Tests finish (3-5 min). The new path does not wait for Tests (they run in parallel and
roll back on failure, as for static sites).

## Host layout

```
/srv/sites/sondafestival.com/
  releases/<sha>/      code only: index.php site/ assets/ kirby/ vendor/   owner sondafestival-com-deploy, 0755/0644
  current -> releases/<sha>
  shared/              owner sondafestival-com-php, 0750 (caddy in the group, for /media)
    content/ media/ accounts/ sessions/ cache/ logs/ license
```

Two users per Kirby site: `<slug>-deploy` (forced command `site-release`, owns releases) and `<slug>-php` (runs the pool, owns
`shared/`). Neither is in the other's group.

## Decisions

### 1. State lives in `shared/`, reached through Kirby roots, not symlinks

`index.php` (and `scripts/create-admin.php`, which boots Kirby itself) reads one env var the pool sets:

```php
$s = getenv('KIRBY_SHARED') ?: null;
$roots = $s ? ['content' => "$s/content", 'media' => "$s/media", 'accounts' => "$s/accounts", 'sessions' => "$s/sessions",
               'cache' => "$s/cache", 'logs' => "$s/logs", 'license' => "$s/license"] : [];
echo (new Kirby(['roots' => $roots]))->render();
```

Unset locally and in tests, so dev is unchanged. Why not symlinks: the release would then contain links pointing outside it,
which `site-release` rejects on purpose (a link out of the release could serve server files), and every release would need
linking. With roots the release is pure code: nothing to link, nothing to exclude from the manifest, nothing for the delete
list to reach. `__DIR__` is the real release dir because Caddy resolves the `current` symlink (decision 2).

`site/languages/*.php` stays code (it carries the Czech smartypants marks). Editing languages in the Panel therefore fails
(read-only); languages change in git. Anything else Kirby writes outside `shared/` is a bug the read-only test (Tests) catches.

### 2. `site.nix` gains `kind = "kirby"`; `site-release` is unchanged

New options on `services.sites.<n>`: `kind` (`"static"` default | `"kirby"`), `phpEnv` (attrs, default `{}`), `www` (bool,
default `true`; staging sets `false`). For `kind = "kirby"` the module adds:

- user/group `<slug>-php`; `users.users.caddy.extraGroups = [ "<slug>-php" ]`.
- `services.phpfpm.pools.<slug>`: `user = <slug>-php`, `phpPackage = pkgs.php85` (same pin as today and the wdk devShell),
  today's `pm` settings, `phpEnv = { KIRBY_SHARED = "${dir}/shared"; KIRBY_DEBUG = "0"; KIRBY_URL = "https://${domain}"; } // site.phpEnv`.
- tmpfiles: `d shared` and each `shared/<dir>` `0750 <slug>-php <slug>-php`.
- vhost (replaces `file_server` for this kind):

  ```
  root * /srv/sites/<d>/current
  encode zstd gzip
  @disallowed path /content/* /site/* /kirby/* /vendor/* /tests/* /scripts/* /.* /composer.* /phpunit.xml
  respond @disallowed 404
  handle /media/* { root * /srv/sites/<d>/shared   file_server }
  handle { php_fastcgi unix/<socket> { resolve_root_symlink }   file_server }
  ${extraConfig}
  ```

`resolve_root_symlink` (Caddy ≥ 2.7) makes Caddy resolve `current` per request, so PHP sees `releases/<sha>/index.php`:
`__DIR__` is real, opcache keys differ per release, and the realpath cache cannot serve the old release after a flip.
That is why **no php-fpm reload and no sudo rule** are needed: the deploy user stays unprivileged and the flip is the whole
deploy. In-flight requests finish on the old release (kept, 5 releases).

Sonda's cache headers (`@assets` immutable, `@fonts`, `@media`) move into its entry's `extraConfig`.

### 3. Asset `?v=` hashes contents

`site/snippets/layout/head.php` uses `?v=<?= Sonda\Assets::version($file) ?>` instead of `->modified()`.
`version()` = first 10 hex chars of `hash_file('xxh128', $root)`, memoised in a static array (5 sheets + a few scripts,
~232 KB total: microseconds per request). No build manifest. `AssetsTest` asserts `?v=` equals the hash, not the mtime.
The wdk Kirby template gets the same helper (as `site/plugins/assets`).

### 4. Build: `vendor/` and `kirby/` ship in the release

```
build:
    rm -rf .wdk/release && mkdir -p .wdk/release
    git archive HEAD | tar -x -C .wdk/release
    composer install -d .wdk/release --no-dev --optimize-autoloader --no-interaction --quiet
```

`wdk.config.js`: `deploy: { host: 'sondafestival-com-deploy@37.205.11.123', dir: '.wdk/release', build: 'just build' }`.

- `git archive HEAD` means the release is exactly the commit it is named after (a dirty tree cannot leak in).
- `.gitattributes` `export-ignore`s `tests/ docs/ inspo/ .github/` and other dev-only files.
- Delta-friendly: `composer.json` sets `"config": {"autoloader-suffix": "sonda"}`, and the archive has no `.git`, so the
  same `composer.lock` gives byte-identical `vendor/` and `kirby/` → zero vendor files in a normal delta. A lock bump sends
  only the changed packages. Mtimes do not matter (the manifest is sha256).
- Composer comes from the kirby devShell (`php85Packages.composer`, already there). No composer, git or GitHub key on the host.

### 5. Delta manifest

No change. `manifest` hashes `current/`, which holds only code; `shared/` is a sibling and never appears. `.wdk-delete` paths
are relative to the new release and traversal is already rejected; the symlink check stays as is (no release symlinks point out).
Release files are not group/other-writable: GNU tar as a non-root user applies the deploy user's umask (022), and `cp -al`
keeps those modes. A test pins this (Tests).

### 6. Content sync

`content.just` keeps its semantics (root SSH, merge-only, backup before push, chown after). Only the variables change:
`production_content := "/srv/sites/sondafestival.com/shared/content"`, `production_pool := "sondafestival-com-php"`, and the
staging pair likewise. vps backup targets move to `shared/content`, `shared/media`, `shared/accounts` (accounts are added:
they were missing). `sessions/`, `cache/`, `logs/` are not backed up.

### 7. Staging

A second entry, no special casing:

```nix
services.sites."staging.sondafestival.com" = {
  kind = "kirby"; www = false; deployKey = "…";
  phpEnv.KIRBY_NOINDEX = "1";
};
```

Own users, pool, `shared/`, not in backups. wdk's reusable `deploy.yml` gets an optional `host` input (passed as `--host`), so
sonda's `deploy-staging.yml` is the same caller with `host: staging-sondafestival-com-deploy@37.205.11.123` and its own secrets.

### 8. Rollback

Rollback flips code only; `shared/` is never touched by `site-release` (no deploy-time hooks, no migrations). Consequences:

- Panel edits made under the newer release survive. Kirby keeps fields the older blueprints do not know (content update
  merges), and sonda's field names are frozen by contract, so old code reads newer content.
- Thumbnails: URLs carry the options hash; the older release regenerates what it needs on demand.
- Sessions and accounts are untouched (cookie key and salt are in `/run/secrets`, not in the release).
- A one-time content migration (like server-contract §8) is never shipped in the same release as code that depends on it;
  it stays a manual step, and undoing it is a backup restore. Take the backup before a release that changes blueprints.
- CI: Tests run in parallel; a failure runs `rollback --if-current <sha>`. Because a PHP fatal breaks every page (unlike a
  static site), the deploy job also checks `curl -fsS --max-time 10 <url>` right after the flip and rolls back on failure
  (reusable `deploy.yml` optional `url` input, ~0.5 s).

### 9. Cutover (production; staging first, same steps)

The public site never stops serving. Old checkout `/srv/sonda-web` stays untouched as the fallback for one week.

1. **sonda PR (ships over the old `git pull` path; behaviour unchanged):** `KIRBY_SHARED` roots in `index.php` and
   `create-admin.php`, `Assets::version()`, `just build`, `.gitattributes`, `autoloader-suffix`, tests. Deploy to staging,
   then main, the old way.
2. **Seed, as root on the host, before the vps apply:** `mkdir -p /srv/sites/sondafestival.com/{releases,shared}`;
   extract a `just build` of the live sha into `releases/<sha>`, `ln -s releases/<sha> current`, `echo <sha> > .history`;
   `rsync -a /srv/sonda-web/{content,media} shared/` and `site/{accounts,sessions,cache}` into `shared/`; copy
   `site/config/.license` to `shared/license` if present. Check `git status --ignored` in `/srv/sonda-web` first for any
   other runtime-written file.
3. **vps apply (one commit):** add the `services.sites."sondafestival.com"` entry, remove the production pool and vhost from
   `sondafestival.nix`, re-own `kirby_content_salt`/`kirby_cookie_key` to `sondafestival-com-php`, move backup targets.
   Keep `sonda-deploy`, its pull key and `/srv/sonda-web`. Immediately after the switch (same script):
   `chown -R sondafestival-com-deploy: releases; chown -R sondafestival-com-php: shared` then
   `rsync -au /srv/sonda-web/content/ shared/content/` to catch any Panel edit made since step 2. Between switch and chown
   (seconds) pages render; only Panel writes and new thumbnails can fail.
4. **sonda PR:** replace `deploy.yml`/`deploy-staging.yml` with the wdk callers (check ∥ deploy, rollback on failure),
   `content.just` variables, server-contract rewrite (§§4, 10, 11, 12, deploy intro). Set `DEPLOY_SSH_KEY`, `DEPLOY_HOST_KEY`.
   Delete secrets `SONDA_DEPLOY_PRIVATE_KEY`, `PRODUCTION_HOST*`, `STAGING_*`.
5. **Prove it:** push a CSS change; time push-to-live, check the new `?v=` is served at once, `wdk deploy rollback`, redeploy,
   Panel edit + upload works, press unlock (sessions) works.
6. **Revert path during the week:** revert the vps commit (old vhost serves `/srv/sonda-web`), then
   `rsync -au shared/content/ /srv/sonda-web/content/` (and media) back, chown to `sonda-deploy`.
7. **After one week (2026-10-19 at the earliest, once 5 is green):** delete `sonda-deploy`/`sonda-staging-deploy` users,
   their keys and sudo rules, `sops.secrets.sonda_pull_private_key` and its templates, the read-only deploy key on the GitHub
   repo, `/srv/sonda-web*`, and what is left of `sondafestival.nix`. Update the roadmap and reference.md ("Not built yet: Kirby").

## Security

- **PHP cannot write code.** Releases are owned by `<slug>-deploy`, 0755/0644; the pool user is not in that group. A PHP
  compromise can change `shared/` (content, accounts) but cannot persist into code or touch other releases.
- **The deploy user cannot read secrets or state.** `/run/secrets/kirby_*` are 0400 `<slug>-php`; `shared/` is 0750
  `<slug>-php`. The deploy key can only run `site-release` (`restrict`, forced command, sha validated).
- Honest limit: the deploy key ships code that then runs as the PHP user, so a leaked deploy key is code execution as that
  user (as today). The split protects against PHP → code persistence, not the reverse.
- No sudo, no composer, no git, no outbound GitHub credential on the host (all three exist today and go away).
- Caddy only serves `shared/` under `/media/*`; `@disallowed` keeps blocking code paths in the release.

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| build or composer fails | nothing uploaded | error names the failed command |
| upload cut / disk full | temp dir removed by trap | `current` unchanged |
| PHP fatal in new release | 500s | curl check rolls back in ~1 s; Tests roll back with `--if-current` |
| Kirby writes outside `shared/` | that write fails (read-only release) | caught before deploy by the read-only test |
| Caddy < 2.7 (no `resolve_root_symlink`) | apply fails Caddyfile validation | site stays on previous generation |
| opcache fills with old releases | FPM restarts opcache by itself | 5 releases × a few MB, well under 128 MB |
| `content.just` still points at `/srv/sonda-web` | pushes land in the dead tree | step 4 updates it with the deploy switch |

## Tests (one per behaviour)

vps `scripts/test-site-release.sh`:
- a planted `shared/content/x` is unchanged after full release, delta release, rollback and pruning past 5.
- `manifest` lists no path outside the release.
- a 0777 file in the tar lands without group/other write.

vps `scripts/test-site-module.nix` (stub gains `services.phpfpm.pools`), a `kind = "kirby"` site next to the static one:
pool user is `<slug>-php`; `phpEnv.KIRBY_SHARED` is `/srv/sites/<d>/shared`; vhost has `resolve_root_symlink`, `@disallowed`
and the `/media/*` handle; tmpfiles make `shared/*` 0750 `<slug>-php`; the static site gets no pool; `www = false` yields no www vhost.

sonda-web:
- `RootsTest`: with `KIRBY_SHARED` set, every writable root resolves under it; unset, defaults.
- `ReadOnlyReleaseTest`: writable roots in a temp dir, render every fixture page and start a session; nothing under the repo
  is created or modified (`find -newer` marker).
- `AssetsTest`: `?v=` equals the content hash.
- `BuildTest`: `just build` output has `vendor/autoload.php` and `kirby/`, no `vendor/phpunit`, no `tests/`; two builds of
  the same commit have identical sha256 manifests.

wdk: `templates.test.js` asserts the reusable `deploy.yml` passes `host` and runs the `url` check with rollback; the Kirby
template's `build` recipe and asset helper exist.

## Tasks, in order

1. vps: `site.nix` `kind`/`phpEnv`/`www` + module test; `test-site-release.sh` additions. Apply (no site uses `kirby` yet).
2. wdk: `deploy.yml` `host` and `url` inputs + test; tag.
3. sonda: decision 1, 3, 4 changes + tests; deploy the old way. Measure `just build` (≤ 3 s).
4. Staging cutover (9.2-9.5 against `staging.sondafestival.com`); measure local `wdk deploy` (≤ 6 s) and CI (≤ 60 s).
5. Production cutover (9.2-9.5). Measure again; if over the "fails" column, stop and fix before step 6.
6. One week later: deletions (9.7).
7. wdk Kirby template: `deploy` config, `build` recipe, asset helper, `index.php` roots, `deploy.yml` caller; reference.md and
   roadmap updated.

## Verified (2026-10-12)

- Caddy on the vps's pinned nixpkgs is 2.11.7, so `resolve_root_symlink` is available.
- Kirby 5.5.2 defines `logs` (`site/logs`) and `license` (`config/.license`) roots (`kirby/src/Cms/Core.php:366-367`).
- Still to confirm on staging: Kirby keeps unknown fields when a page is saved (rollback depends on it).
- The task list above is the plan; each task is executed test-first.

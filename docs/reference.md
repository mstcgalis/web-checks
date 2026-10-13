# Reference

## Use in an existing project

```nix
# flake.nix
{
  inputs.wdk.url = "github:mstcgalis/web-dev-kit"; # pinned by flake.lock; `nix flake update wdk` to upgrade
  inputs.nixpkgs.follows = "wdk/nixpkgs";
  outputs = { wdk, nixpkgs, ... }: {
    devShells = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-linux" ] (system: {
      default = wdk.lib.devShell { pkgs = nixpkgs.legacyPackages.${system}; stack = "kirby"; }; # or "static"
    });
  };
}
```

The project's `justfile` must have **`serve-at PORT`**: a foreground server on PORT. Every command
starts the site through it. Static sites use `wdk serve-dir DIR {{PORT}}`.

## Browsers

On Linux the dev shell provides them. On macOS, `wdk install-browsers` downloads only what the
configured engines need and is not already on disk; with Google Chrome installed, the default config
needs nothing (Chrome stands in for Playwright's Chromium). `wdk doctor` lists what is missing and
the fix.

## Exit codes

0 pass, 1 findings, 2 broken setup (the message says the fix). `doctor` exits 1 if anything is missing;
`compat` exits 2 if its globs match nothing; `shots`, `perf` and `load` exit 0.

## `wdk.config.js`

```js
export default {
  pages: { start: ['/', '/does-not-exist'], skip: '^/(media|panel)\\b', limit: 80 },
  engines: { ci: ['chromium', 'firefox', 'webkit'], local: ['chrome', 'firefox', 'webkit', 'exe:firefox:$WDK_FIREFOX_115'] },
  viewports: [[390, 844], [1440, 900]],
  compat: { css: ['assets/css/*.css'], targets: 'defaults, Firefox >= 115', allow: [] },
  proxy: { block: ['panel', 'api', '*.php'] },
  perf: { page: '/', knobs: { zoom: { css: '…', probe: '.slide img' }, seismo: { script: 'seismograph' } } },
};
```

- `pages`: crawl entry points, a skip regex, and a page limit.
- `engines`: `ci` and `local` lists. An engine is `chrome` (branded), `chromium`, `firefox`, `webkit`,
  or `exe:<firefox|chrome>:<path>` for a binary Playwright cannot drive; the path may be `$VAR`.
- `compat`: stylesheet globs, a browserslist `targets`, and `allow` for accepted findings. With no
  `css`, `check` skips compat.
- `proxy.block`: paths the proxy refuses.
- `perf`: the page to measure and the knobs (CSS or script variants) to compare.

Every browser goes through a proxy that injects an error beacon, which is how `exe:` engines report
errors. The proxy also takes `?wdk-off=a,b|static`, `?wdk-mouse` and `?wdk-freeze`, so
`wdk perf --serve` variants open on any device on the LAN.

Measurement pitfalls: [`perf.md`](perf.md).

## Private repos

Site repos stay private; Nix fetches them (and the wdk, if it goes private) with one GitHub token,
`NIX_ACCESS_TOKEN`: a fine-grained PAT, Contents read and Actions read and write (dispatching the vps
deploy), on all repositories, so new repos need no per-repo step. Locally:
`access-tokens = github.com=<token>` in `~/.config/nix/nix.conf`. In CI: a repo secret of that name
(the vps repo needs it; the reusable `check.yml` uses it when set and callers pass only that secret).
The bootstrap CLI will set it with `gh secret set`.

## Deploys

Release deploys: a site is a directory on the vps, `/srv/sites/<domain>/releases/<sha>/`, with a
`current` symlink flipped atomically (5 releases kept). Push to `main`: the template's `deploy.yml` runs
`check` and `deploy` in parallel (a hotfix never waits on browsers); `deploy.yml` runs `wdk deploy`, which
builds (`deploy.build`), asks the host for a hash manifest of the current release and streams only the
changed files (plus a delete list) as `tar | zstd | ssh` to the site's restricted key (a full tar when
there is no current release). The vps `site-release` forced command hardlinks the old release, applies
the delta and flips: seconds even for a 140 MB site, no vps CI. If `check` then fails, a
`rollback` job runs `wdk deploy rollback --if-current <sha>` (a no-op if a newer release landed).
Optional inputs of the reusable `deploy.yml`: `host` (deploy to that `user@host`, e.g. staging), `url` (curl it after the flip; a failure rolls back) and `ref` (deploy that commit; a `workflow_run` caller passes `github.event.workflow_run.head_sha` so only the tested commit ships).

- Config: `deploy: { host: 'SITE-deploy@HOST', dir: 'dist', build: 'just build' }` in `wdk.config.js`.
- Secrets on the site repo: `DEPLOY_SSH_KEY` (private key), `DEPLOY_HOST_KEY` (`ssh-keyscan -t ed25519 HOST`
  line, pinned). vps: `services.sites.<name>.deployKey` = the public half (user `<slug>-deploy`, `restrict`).
- By hand: `wdk deploy`, `wdk deploy rollback`, `wdk deploy list`.
- Kirby sites (`kind = "kirby"`, sonda-web production and staging) keep mutable state in `shared/`, set by the PHP-FPM pool's `KIRBY_SHARED`; releases are read-only code. Not built yet: the wdk Kirby template (deploy config, build recipe, asset hash helper, roots).

## Branches and releases

Projects: `staging` deploys staging, `main` deploys production; both fast-forward only, conventional
commits. The wdk itself: work on `web-kit`, fast-forward `main`, tag `vX.Y.Z` from `main`
(`package.json` is the version source). Then `just lock-templates` and commit, so new projects start
on this release. Projects run `wdk update` (workflow pins and `flake.lock` to the latest release; nothing committed). Each template ships `update.yml`: weekly, it runs that and opens a PR; it needs `NIX_ACCESS_TOKEN` with Contents and Pull requests write on the project. After changing `bun.lock`, run `just hash` and
update `outputHash` in `flake.nix`.

`just check` is the fast suite (before every commit); `just check-all` runs every test, as CI does.

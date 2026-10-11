# web-dev-kit

Shared tooling for web projects, delivered as a Nix flake: the `wdk` command (checks) and dev
shells per stack. Part of a larger system for delivering sites; see [`docs/roadmap.md`](docs/roadmap.md).

## New project

```sh
nix flake init -t github:mstcgalis/web-dev-kit#static   # or kirby, eleventy, vite, astro
```

Each template is a flake, a `justfile` (`serve-at`, `build`, `check`), a `wdk.config.js` and a
starter page. `static` serves `site/`; `eleventy` builds `src/` to `_site/` with Eleventy; `vite` builds to `dist/` with Vite; `astro` builds to `dist/` with Astro;
`kirby` expects Kirby in `./kirby` (git submodule) and serves it with `php -S`.

## Use in a project

```nix
# flake.nix
{
  inputs.wdk.url = "github:mstcgalis/web-dev-kit/v0.6.2";
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

On macOS, run `wdk install-browsers` once. On Linux the dev shell provides the browsers.

## Commands

| | | Exit |
|---|---|---|
| `wdk a11y` | axe-core, WCAG 2.2 AA + best practice, every crawled page | 1 on violations |
| `wdk compat` | `compat.css` against `compat.targets` (browserslist), via doiuse | 1 on findings, 2 if globs match nothing |
| `wdk smoke` | every page × engine; runtime errors, `console.error`, broken same-origin requests | 1 on errors |
| `wdk shots` | contact sheet at `.wdk/shots/…/index.html`: pages × engine × viewport | 0 |
| `wdk perf` | CPU per perf knob, idle and mouse; macOS only (see traps below) | 0 |

`--engines a,b` overrides the config for `smoke`, `shots` and `perf`; `--skip REGEX` for the crawl.

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

Engines: `chrome` (branded), `chromium`, `firefox`, `webkit`, or `exe:<firefox|chrome>:<path>` for a
binary Playwright cannot drive. The path may be `$VAR`.

Every browser goes through a proxy that injects an error beacon, which is how `exe:` engines report
errors. The proxy also takes `?wdk-off=a,b|static`, `?wdk-mouse` and `?wdk-freeze`, so
`wdk perf --serve` variants open on any device on the LAN.

## Measurement traps (perf)

Each of these produced confident, wrong numbers once:
1. Rosetta: an x86 parent launches browsers translated. `wdk perf` refuses to run.
2. Chrome on SwiftShader instead of Metal: fixed by `CHROME_ARGS`.
3. Counting one process: count the whole tree, including GPU and XPC helpers.
4. Background tabs keep animating: one page per measurement.
5. Occluded windows aren't composited: the window is forced frontmost before sampling.
6. Firefox ESR updates itself: use the flake's pinned FF115 (`$WDK_FIREFOX_115`).
7. One run proves nothing: the median and range of `--repeat` runs.
8. Warm-up shorter than the page's own wake time (a loop that sleeps once settled): you measure the
   wake. Raise `--warm`.
9. A dev server shared with another check (a11y, smoke) gets restarted mid-run: give perf its own.
10. Firefox and WebKit on a machine in use: Firefox crashes mid-matrix, WebKit's pointer stops when
    the window loses the front. Hands off, or measure Chrome only.

## Develop

`nix develop`, then `bun install`, then `just check`. After changing `bun.lock`, run `just hash` and
update `outputHash` in `flake.nix`.

## Private repos

Site repos stay private; Nix fetches them (and the wdk, if it goes private) with one read-only GitHub
token, `NIX_ACCESS_TOKEN`: a fine-grained PAT, Contents read-only, on all repositories, so new repos
need no per-repo step. Locally: `access-tokens = github.com=<token>` in `~/.config/nix/nix.conf`. In CI:
a repo secret of that name (the vps repo needs it; the reusable `check.yml` uses it when set and callers
pass only that secret). The bootstrap CLI sets it with `gh secret set`.

## Branches and releases

Projects: `staging` deploys staging, `main` deploys production; both fast-forward only, conventional
commits. The wdk itself: work on `web-kit`, fast-forward `main`, tag `vX.Y.Z` from `main` (semver;
`package.json` is the version source). Projects bump `inputs.wdk` to the tag.

## Licence

AGPL-3.0.

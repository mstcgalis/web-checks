# Measurement traps (`wdk perf`)

Each of these produced confident, wrong numbers once.

1. Rosetta: an x86 parent launches browsers translated. `wdk perf` refuses to run.
2. Chrome on SwiftShader instead of Metal: fixed by `CHROME_ARGS`.
3. Counting one process: count the whole tree, including GPU and XPC helpers.
4. Background tabs keep animating: one page per measurement.
5. Occluded windows aren't composited: the window is forced frontmost before sampling.
6. Firefox ESR updates itself: use the flake's pinned FF115 (`$WDK_FIREFOX_115`, fetched on first use).
7. One run proves nothing: the median and range of `--repeat` runs.
8. Warm-up shorter than the page's own wake time (a loop that sleeps once settled): you measure the
   wake. Raise `--warm`.
9. A dev server shared with another check (a11y, smoke) gets restarted mid-run: give perf its own.
10. Firefox and WebKit on a machine in use: Firefox crashes mid-matrix, WebKit's pointer stops when
    the window loses the front. Hands off, or measure Chrome only.

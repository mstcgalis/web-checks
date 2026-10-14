import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wdk } from './run.js';

const WDK = join(import.meta.dir, '..', 'bin', 'wdk.js');
// A throwaway project: one clean page, a justfile and a config.
function project({ justfile = `serve-at PORT:\n    bun ${WDK} serve-dir site {{PORT}}\n`, config = {}, configText = `export default ${JSON.stringify(config)};` } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-cli-'));
	mkdirSync(join(dir, 'site'));
	const page = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t}</title></head><body><main><h1>${t}</h1></main></body></html>`;
	writeFileSync(join(dir, 'site', 'index.html'), page('Home'));
	writeFileSync(join(dir, 'site', '404.html'), page('Not found'));
	writeFileSync(join(dir, 'justfile'), justfile);
	writeFileSync(join(dir, 'wdk.config.js'), configText);
	return dir;
}
const inDir = (dir, args, env = {}) => wdk(args, env, dir);
const noBrowsers = () => ({ PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(join(tmpdir(), 'wdk-nobrowsers-')) });

test.concurrent('no command prints help with every command and exits 0', async () => {
	const r = await wdk([]);
	for (const c of ['check', 'compat', 'smoke', 'a11y', 'load', 'shots', 'perf', 'doctor', 'update', 'deploy', 'install-browsers', 'serve-dir']) expect(r.out).toContain(`  ${c} `);
	expect(r.code).toBe(0);
	expect((await wdk(['smoke', '--help'])).out).toContain('wdk <command>');
});

test.concurrent('unknown command names it, prints help and exits 2', async () => {
	const r = await wdk(['nope']);
	expect(r.err).toContain('wdk: unknown command "nope"');
	expect(r.err).toContain('wdk <command>');
	expect(r.code).toBe(2);
});

test.concurrent('a bad option or --skip regex says what is wrong, exit 2', async () => {
	const opt = await wdk(['check', '--bogus']);
	expect(opt.err).toBe("wdk check: Unknown option '--bogus' (wdk --help lists the options)\n");
	expect(opt.code).toBe(2);
	const re = await inDir(project({}), ['smoke', '--skip', '(']);
	expect(re.err).toBe('wdk smoke: pages.skip / --skip "(" is not a valid regex\n');
	expect(re.code).toBe(2);
});

test.concurrent('check runs compat, smoke and a11y on one server; findings before each summary line', async () => {
	const r = await wdk(['check']);
	expect(r.out).toContain('✗ site/style.css:3 — ');
	expect(r.out).toContain('✗ compat 1 file(s), 1 unsupported feature use(s)');
	expect(r.out).toContain('✗ chromium /broken — 404 /missing.png');
	expect(r.out).toContain('✗ smoke  4 pages × 1 engine(s), 2 error(s)');
	expect(r.out).toContain('    /about  img');
	expect(r.out).toContain('✗ a11y   4 pages, 1 violation(s)');
	expect(r.err).toBe(''); // no recipe echo, no server chatter
	expect(r.code).toBe(1);
}, 60_000);

test.concurrent('check passes clean pages and skips compat without compat.css', async () => {
	const r = await inDir(project(), ['check']);
	expect(r.out).toBe('- compat skipped: no compat.css in wdk.config.js\n✓ smoke  2 pages × 1 engine(s), 0 error(s)\n✓ a11y   2 pages, 0 violation(s)\n');
	expect(r.code).toBe(0);
}, 60_000);

test.concurrent('check reports a compat config that cannot be checked as broken setup, and still runs the rest', async () => {
	const dir = project({ config: { compat: { css: ['site/*.css'], targets: 'bogus browser' } } });
	writeFileSync(join(dir, 'site', 'a.css'), 'a{color:red}');
	const r = await inDir(dir, ['check']);
	expect(r.out).toMatch(/^✗ compat .*bogus/m);
	expect(r.out).toContain('✓ smoke ');
	expect(r.code).toBe(2);
}, 60_000);

test.concurrent('doctor passes the fixture', async () => {
	const r = await wdk(['doctor']);
	expect(r.out).toContain('✓ compat.css matches 1 file(s)');
	expect(r.out).toMatch(/✓ just serve-at answers \(\d+ ms\)/);
	expect(r.code).toBe(0);
}, 30_000);

test.concurrent('doctor names what is missing and the fix', async () => {
	const r = await inDir(project({ justfile: 'build:\n    true\n', config: { engines: { ci: ['firefox'], local: ['firefox'] } } }), ['doctor'], noBrowsers());
	expect(r.out).toContain('✗ firefox is not installed');
	expect(r.out).toContain('✗ the justfile has no `serve-at PORT` recipe');
	expect(r.code).toBe(1);
}, 30_000);

test.concurrent('a missing browser is one actionable line, exit 2', async () => {
	const r = await wdk(['smoke', '--engines', 'firefox'], noBrowsers());
	expect(r.err.trim()).toMatch(/^wdk smoke: firefox is not installed — (run: wdk install-browsers firefox|run inside the wdk dev shell \(nix develop\))$/);
	expect(r.code).toBe(2);
}, 30_000);

test.concurrent('install-browsers: nothing to download when the engines are on disk; unknown engines exit 2', async () => {
	expect((await wdk(['install-browsers'])).out).toBe('nothing to install\n');
	const r = await wdk(['install-browsers', 'opera']);
	expect(r.err).toContain('unknown engine(s) opera');
	expect(r.code).toBe(2);
}, 30_000);

test.concurrent('a broken or misspelt wdk.config.js is named with the fix, exit 2', async () => {
	const broken = await inDir(project({ configText: 'export default {' }), ['check']);
	expect(broken.err).toMatch(/^wdk check: wdk\.config\.js:1:\d+: /);
	expect(broken.code).toBe(2);
	const typo = await inDir(project({ config: { page: {} } }), ['doctor']);
	expect(typo.out).toContain('✗ wdk.config.js: unknown key(s) page — expected pages, engines');
	expect(typo.code).toBe(1);
	const nested = await inDir(project({ config: { pages: { skp: 'x' } } }), ['check']);
	expect(nested.err).toContain('unknown key(s) pages.skp — expected pages.start, pages.skip, pages.limit');
	expect(nested.code).toBe(2);
});

test.concurrent('a justfile without serve-at says what to add', async () => {
	const r = await inDir(project({ justfile: 'build:\n    true\n' }), ['smoke']);
	expect(r.err).toContain('the justfile needs `serve-at PORT`, a foreground server on PORT');
	expect(r.code).toBe(2);
}, 30_000);

test.concurrent('update re-pins the wdk workflows and a tag-pinned input, then updates the lock', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-update-'));
	mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
	const wf = (v) => `jobs:\n  a:\n    uses: mstcgalis/web-dev-kit/.github/workflows/check.yml@${v}\n  b:\n    uses: actions/checkout@v4\n`;
	writeFileSync(join(dir, '.github', 'workflows', 'check.yml'), wf('v0.1.0'));
	writeFileSync(join(dir, 'flake.nix'), '{ inputs.wdk.url = "github:mstcgalis/web-dev-kit/v0.1.0"; }');
	const bin = mkdtempSync(join(tmpdir(), 'wdk-fakenix-'));
	writeFileSync(join(bin, 'nix'), `#!/bin/sh\necho "$@" > ${dir}/nix-args\n`, { mode: 0o755 });
	const r = await inDir(dir, ['update', '--tag', 'v9.9.9'], { PATH: `${bin}:${process.env.PATH}` });
	expect(r.code).toBe(0);
	expect(r.out).toContain('flake.nix -> v9.9.9');
	expect(readFileSync(join(dir, '.github', 'workflows', 'check.yml'), 'utf8')).toBe(wf('v9.9.9'));
	expect(readFileSync(join(dir, 'flake.nix'), 'utf8')).toContain('web-dev-kit/v9.9.9"');
	expect(readFileSync(join(dir, 'nix-args'), 'utf8').trim()).toBe('flake update wdk');
});

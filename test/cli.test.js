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
const inDir = (dir, args, env = {}) => {
	const r = Bun.spawnSync(['bun', WDK, ...args], { cwd: dir, env: { ...process.env, ...env } });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const noBrowsers = () => ({ PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(join(tmpdir(), 'wdk-nobrowsers-')) });

test('no command prints help with every command and exits 0', () => {
	const r = wdk([]);
	for (const c of ['check', 'compat', 'smoke', 'a11y', 'load', 'shots', 'perf', 'doctor', 'update', 'install-browsers', 'serve-dir']) expect(r.out).toContain(`  ${c} `);
	expect(r.code).toBe(0);
	expect(wdk(['smoke', '--help']).out).toContain('wdk <command>');
});

test('unknown command names it, prints help and exits 2', () => {
	const r = wdk(['nope']);
	expect(r.err).toContain('wdk: unknown command "nope"');
	expect(r.err).toContain('wdk <command>');
	expect(r.code).toBe(2);
});

test('a bad option or --skip regex says what is wrong, exit 2', () => {
	const opt = wdk(['check', '--bogus']);
	expect(opt.err).toBe("wdk check: Unknown option '--bogus' (wdk --help lists the options)\n");
	expect(opt.code).toBe(2);
	const re = inDir(project({}), ['smoke', '--skip', '(']);
	expect(re.err).toBe('wdk smoke: pages.skip / --skip "(" is not a valid regex\n');
	expect(re.code).toBe(2);
});

test('check runs compat, smoke and a11y on one server; findings before each summary line', () => {
	const r = wdk(['check']);
	expect(r.out).toContain('✗ site/style.css:3 — ');
	expect(r.out).toContain('✗ compat 1 file(s), 1 unsupported feature use(s)');
	expect(r.out).toContain('✗ chromium /broken — 404 /missing.png');
	expect(r.out).toContain('✗ smoke  4 pages × 1 engine(s), 2 error(s)');
	expect(r.out).toContain('    /about  img');
	expect(r.out).toContain('✗ a11y   4 pages, 1 violation(s)');
	expect(r.err).toBe(''); // no recipe echo, no server chatter
	expect(r.code).toBe(1);
}, 60_000);

test('check passes clean pages and skips compat without compat.css', () => {
	const r = inDir(project(), ['check']);
	expect(r.out).toBe('- compat skipped: no compat.css in wdk.config.js\n✓ smoke  2 pages × 1 engine(s), 0 error(s)\n✓ a11y   2 pages, 0 violation(s)\n');
	expect(r.code).toBe(0);
}, 60_000);

test('doctor passes the fixture', () => {
	const r = wdk(['doctor']);
	expect(r.out).toContain('✓ compat.css matches 1 file(s)');
	expect(r.out).toMatch(/✓ just serve-at answers \(\d+ ms\)/);
	expect(r.code).toBe(0);
}, 30_000);

test('doctor names what is missing and the fix', () => {
	const r = inDir(project({ justfile: 'build:\n    true\n', config: { engines: { ci: ['firefox'], local: ['firefox'] } } }), ['doctor'], noBrowsers());
	expect(r.out).toContain('✗ firefox is not installed');
	expect(r.out).toContain('✗ the justfile has no `serve-at PORT` recipe');
	expect(r.code).toBe(1);
}, 30_000);

test('a missing browser is one actionable line, exit 2', () => {
	const r = wdk(['smoke', '--engines', 'firefox'], noBrowsers());
	expect(r.err.trim()).toMatch(/^wdk smoke: firefox is not installed — (run: wdk install-browsers firefox|run inside the wdk dev shell \(nix develop\))$/);
	expect(r.code).toBe(2);
}, 30_000);

test('install-browsers: nothing to download when the engines are on disk; unknown engines exit 2', () => {
	expect(wdk(['install-browsers']).out).toBe('nothing to install\n');
	const r = wdk(['install-browsers', 'opera']);
	expect(r.err).toContain('unknown engine(s) opera');
	expect(r.code).toBe(2);
}, 30_000);

test('a broken or misspelt wdk.config.js is named with the fix, exit 2', () => {
	const broken = inDir(project({ configText: 'export default {' }), ['check']);
	expect(broken.err).toMatch(/^wdk check: wdk\.config\.js:1:\d+: /);
	expect(broken.code).toBe(2);
	const typo = inDir(project({ config: { page: {} } }), ['doctor']);
	expect(typo.out).toContain('✗ wdk.config.js: unknown key(s) page — expected pages, engines');
	expect(typo.code).toBe(1);
	const nested = inDir(project({ config: { pages: { skp: 'x' } } }), ['check']);
	expect(nested.err).toContain('unknown key(s) pages.skp — expected pages.start, pages.skip, pages.limit');
	expect(nested.code).toBe(2);
});

test('a justfile without serve-at says what to add', () => {
	const r = inDir(project({ justfile: 'build:\n    true\n' }), ['smoke']);
	expect(r.err).toContain('the justfile needs `serve-at PORT`, a foreground server on PORT');
	expect(r.code).toBe(2);
}, 30_000);

test('update re-pins the wdk workflows and a tag-pinned input, then updates the lock', () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-update-'));
	mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
	const wf = (v) => `jobs:\n  a:\n    uses: mstcgalis/web-dev-kit/.github/workflows/check.yml@${v}\n  b:\n    uses: actions/checkout@v4\n`;
	writeFileSync(join(dir, '.github', 'workflows', 'check.yml'), wf('v0.1.0'));
	writeFileSync(join(dir, 'flake.nix'), '{ inputs.wdk.url = "github:mstcgalis/web-dev-kit/v0.1.0"; }');
	const bin = mkdtempSync(join(tmpdir(), 'wdk-fakenix-'));
	writeFileSync(join(bin, 'nix'), `#!/bin/sh\necho "$@" > ${dir}/nix-args\n`, { mode: 0o755 });
	const r = inDir(dir, ['update', '--tag', 'v9.9.9'], { PATH: `${bin}:${process.env.PATH}` });
	expect(r.code).toBe(0);
	expect(r.out).toContain('flake.nix -> v9.9.9');
	expect(readFileSync(join(dir, '.github', 'workflows', 'check.yml'), 'utf8')).toBe(wf('v9.9.9'));
	expect(readFileSync(join(dir, 'flake.nix'), 'utf8')).toContain('web-dev-kit/v9.9.9"');
	expect(readFileSync(join(dir, 'nix-args'), 'utf8').trim()).toBe('flake update wdk');
});

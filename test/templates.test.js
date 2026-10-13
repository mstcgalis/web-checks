import { expect, test } from 'bun:test';
import { slow } from './run.js';
import { chmodSync, cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

// A `wdk` on PATH, as the dev shell provides, so a template's serve-at recipe resolves.
const bin = mkdtempSync(join(tmpdir(), 'wdk-bin-'));
writeFileSync(join(bin, 'wdk'), `#!/bin/sh\nexec bun ${ROOT}/bin/wdk.js "$@"\n`);
chmodSync(join(bin, 'wdk'), 0o755);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

const sh = (args, cwd) => {
	const r = Bun.spawnSync(args, { cwd, env });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
// Fails with the command's stderr, not a bare exit code.
const ok = (args, cwd) => {
	const r = sh(args, cwd);
	expect(r.code ? `${args.join(' ')} exited ${r.code}: ${r.err}` : '').toBe('');
	return r;
};

function project(name) {
	const dir = mkdtempSync(join(tmpdir(), `wdk-tpl-${name}-`));
	cpSync(join(ROOT, 'templates', name), dir, { recursive: true });
	return dir;
}

for (const name of ['static', 'eleventy', 'vite', 'astro']) {
	slow(`template ${name}: wdk check passes`, () => {
		const dir = project(name);
		if (name !== 'static') {
			ok(['bun', 'install', '--frozen-lockfile'], dir);
			ok(['just', 'build'], dir);
		}
		const check = sh(['wdk', 'check', '--engines', 'chromium'], dir);
		expect(check.out).toContain('✓ smoke ');
		expect(check.code).toBe(0);
	}, 180_000);
}

test('template kirby: has its files and a parseable justfile', async () => {
	const dir = project('kirby');
	for (const f of ['flake.nix', 'justfile', 'wdk.config.js', '.gitignore', '.envrc', 'composer.json', 'composer.lock', 'index.php', 'roots.php', 'tests/router.php', '.github/workflows/deploy.yml', 'assets/css/style.css']) expect(await Bun.file(join(dir, f)).exists()).toBe(true);
	expect(sh(['just', '--list'], dir).code).toBe(0);
});

// Needs php and composer (the kirby dev shell has both) and the network for composer.
slow('template kirby: build ships code only, assets get a content hash, wdk check passes', () => {
	const dir = project('kirby');
	for (const c of [['git', 'init', '-q'], ['git', 'add', '-A'], ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], ['composer', 'install', '--no-interaction', '--quiet'], ['just', 'build']]) expect(sh(c, dir).code).toBe(0);
	const rel = join(dir, '.wdk/release');
	for (const f of ['index.php', 'roots.php', 'vendor/autoload.php', 'kirby/bootstrap.php', 'site/plugins/assets/index.php']) expect(existsSync(join(rel, f))).toBe(true);
	for (const f of ['tests', '.github', 'justfile', 'wdk.config.js']) expect(existsSync(join(rel, f))).toBe(false);
	const check = sh(['wdk', 'check', '--engines', 'chromium'], dir);
	expect(check.out).toContain('✓ smoke ');
	expect(check.code).toBe(0);
	const html = sh(['php', '-r', 'chdir($argv[1]); $_SERVER["REQUEST_URI"] = "/"; include "tests/router.php";', dir], dir).out;
	expect(html).toMatch(/style\.css\?v=[0-9a-f]{12}"/);
}, 300_000);

// templates are copied standalone by `nix flake init`, so the shared rules are duplicated; keep them in sync
test('AGENTS.md shared rules (above the ---) are identical across templates', async () => {
	const [a, ...rest] = (await Promise.all(['static', 'eleventy', 'vite', 'astro', 'kirby'].map((t) => Bun.file(join(ROOT, 'templates', t, 'AGENTS.md')).text()))).map((t) => t.split('\n---\n')[0]);
	for (const r of rest) expect(r).toBe(a);
});

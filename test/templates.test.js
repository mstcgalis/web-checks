import { expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function project(name) {
	const dir = mkdtempSync(join(tmpdir(), `wdk-tpl-${name}-`));
	cpSync(join(ROOT, 'templates', name), dir, { recursive: true });
	return dir;
}

for (const name of ['static', 'eleventy', 'vite']) {
	test(`template ${name}: compat, smoke and a11y pass`, () => {
		const dir = project(name);
		if (name !== 'static') {
			expect(sh(['bun', 'install'], dir).code).toBe(0);
			expect(sh(['just', 'build'], dir).code).toBe(0);
		}
		expect(sh(['wdk', 'compat'], dir).code).toBe(0);
		const smoke = sh(['wdk', 'smoke', '--engines', 'chromium'], dir);
		expect(smoke.out).toContain('0 error(s)');
		expect(smoke.code).toBe(0);
		expect(sh(['wdk', 'a11y'], dir).code).toBe(0);
	}, 180_000);
}

test('template kirby: has its files and a parseable justfile', async () => {
	const dir = project('kirby');
	for (const f of ['flake.nix', 'justfile', 'wdk.config.js', '.gitignore', 'assets/css/style.css']) expect(await Bun.file(join(dir, f)).exists()).toBe(true);
	expect(sh(['just', '--list'], dir).code).toBe(0);
});

// templates are copied standalone by `nix flake init`, so the shared rules are duplicated; keep them in sync
test('AGENTS.md is identical across templates', async () => {
	const [a, ...rest] = await Promise.all(['static', 'eleventy', 'vite', 'kirby'].map((t) => Bun.file(join(ROOT, 'templates', t, 'AGENTS.md')).text()));
	for (const r of rest) expect(r).toBe(a);
});

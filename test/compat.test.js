import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wdk } from './run.js';

const WDK = join(import.meta.dir, '..', 'bin', 'wdk.js');
const inDir = (config) => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-compat-'));
	writeFileSync(join(dir, 'a.css'), 'main:has(.x) { color: red; }\n');
	writeFileSync(join(dir, 'wdk.config.js'), `export default ${JSON.stringify({ compat: config })};`);
	const r = Bun.spawnSync(['bun', WDK, 'compat'], { cwd: dir });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

test('reports the planted :has() against Firefox 115 with file and line', async () => {
	const r = await wdk(['compat']);
	expect(r.out).toContain('✗ site/style.css:3 — ');
	expect(r.out).toContain('(css-has)');
	expect(r.out).toContain('1 file(s), 1 unsupported feature use(s) for "Firefox >= 115"');
	expect(r.code).toBe(1);
});

test('allow suppresses a deliberate feature', async () => {
	const r = inDir({ css: ['*.css'], targets: 'Firefox >= 115', allow: ['css-has'] });
	expect(r.out).toContain('0 unsupported');
	expect(r.code).toBe(0);
});

test('globs that match nothing are a config error, not a pass', async () => {
	const r = inDir({ css: ['nope/*.css'], targets: 'Firefox >= 115' });
	expect(r.err).toContain('matched no files');
	expect(r.code).toBe(2);
});

test('no globs configured is a config error', async () => {
	const r = inDir({});
	expect(r.err).toContain('compat.css');
	expect(r.code).toBe(2);
});

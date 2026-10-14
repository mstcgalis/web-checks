import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from '../lib/cmd/a11y.js';
import { slow, wdk } from './run.js';

const WDK = join(import.meta.dir, '..', 'bin', 'wdk.js');

test('a11y crawls from the start paths and fails on the violation one link away', () => {
	const r = wdk(['a11y']);
	expect(r.out).toContain('✗ image-alt (critical): Images must have alternative text — 1 page(s)');
	expect(r.out).toContain('    /about  img');
	expect(r.out).toContain('4 pages, 1 violation(s)');
	expect(r.code).toBe(1);
}, 60_000);

test('a11y --skip keeps the crawl on clean pages', () => {
	const r = wdk(['a11y', '--skip', '^/about']);
	expect(r.out).toContain('3 pages, 0 violation(s)');
	expect(r.code).toBe(0);
}, 60_000);

test('a11y audits a page whose CSP forbids injected scripts', () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-csp-'));
	mkdirSync(join(dir, 'site'));
	writeFileSync(join(dir, 'site', 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>CSP</title></head><body><main><h1>CSP</h1><img src="data:,"></main></body></html>`);
	writeFileSync(join(dir, 'justfile'), `serve-at PORT:\n    bun ${WDK} serve-dir site {{PORT}}\n`);
	writeFileSync(join(dir, 'wdk.config.js'), `export default { pages: { start: ['/'] } };`);
	const r = Bun.spawnSync(['bun', WDK, 'a11y'], { cwd: dir });
	expect(r.stdout.toString()).toContain('✗ image-alt (critical)');
	expect(r.exitCode).toBe(1);
}, 60_000);

test('report groups by rule in page order and names pages axe never ran on', () => {
	const v = { id: 'image-alt', impact: 'critical', help: 'Images must have alternative text', nodes: [{ target: ['img'] }] };
	const r = report(new Map([['/b', [v]], ['/a', [v]]]), ['/a', '/b', '/c']);
	expect(r.lines).toEqual([
		'✗ image-alt (critical): Images must have alternative text — 2 page(s)',
		'    /a  img',
		'    /b  img',
		'✗ not audited, the page did not load (wdk smoke says why): /c',
	]);
	expect(r.summary).toBe('3 pages, 2 violation(s), 1 not audited');
	expect(r.code).toBe(1);
});

slow('check without a Blink engine still audits, in a Chromium pass of its own', () => {
	const r = wdk(['check', '--engines', 'webkit', '--skip', '^/broken']);
	expect(r.out).toContain('✓ smoke  3 pages × 1 engine(s), 0 error(s)');
	expect(r.out).toContain('✗ a11y   3 pages, 1 violation(s)');
}, 120_000);

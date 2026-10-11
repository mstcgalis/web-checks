import { expect, test } from 'bun:test';
import { wdk } from './run.js';

test('load reports LCP and image bytes per page × viewport, the heaviest image named', () => {
	const r = wdk(['load', '--skip', '^/about']);
	expect(r.code).toBe(0);
	expect(r.out).toMatch(/^\/$/m);
	expect(r.out).toMatch(/390×844@3 4G {2}LCP \d+ ms \(plasma\.jpg\) {2}images 1 files \d+ KB · after scroll 1 files/);
	expect(r.out).toMatch(/1280×800@2 {2}LCP \d+ ms/);
	expect(r.out).toMatch(/\d+ KB {2}\/plasma\.jpg/);
}, 120_000);

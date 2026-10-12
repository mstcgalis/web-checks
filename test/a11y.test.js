import { expect, test } from 'bun:test';
import { wdk } from './run.js';

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

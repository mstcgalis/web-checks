import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { wdk, slow } from './run.js';

test('smoke fails on the runtime error and the missing image, not on the 404 start path', () => {
	const r = wdk(['smoke']);
	expect(r.out).toMatch(/✗ chromium \/broken — pageerror: .*boom/);
	expect(r.out).toContain('✗ chromium /broken — 404 /missing.png');
	expect(r.out).not.toContain('/does-not-exist —');
	expect(r.out).not.toContain('Failed to load resource');
	expect(r.out).toContain('4 pages × 1 engine(s), 2 error(s)');
	expect(r.code).toBe(1);
}, 60_000);

test('smoke passes once the broken page is skipped', () => {
	const r = wdk(['smoke', '--skip', '^/broken']);
	expect(r.out).toContain('3 pages × 1 engine(s), 0 error(s)');
	expect(r.code).toBe(0);
}, 60_000);

test('smoke exits 2 on invalid engine', () => {
	const r = wdk(['smoke', '--engines', 'bogus']);
	expect(r.err).toContain('wdk smoke:');
	expect(r.err).toContain('unknown engine');
	expect(r.code).toBe(2);
});

slow('exe engines report through the beacon and the proxy', () => {
	const r = wdk(['smoke', '--engines', 'exe:chrome:$WDK_TEST_CHROME'], { WDK_TEST_CHROME: chromium.executablePath() });
	expect(r.out).toMatch(/✗ exe:chrome:\$WDK_TEST_CHROME \/broken — error: .*boom/);
	expect(r.out).toContain('✗ exe:chrome:$WDK_TEST_CHROME /broken — 404 /missing.png');
	expect(r.out).not.toContain('/does-not-exist —');
	expect(r.code).toBe(1);
}, 120_000);

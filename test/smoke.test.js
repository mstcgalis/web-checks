import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { wdk, slow } from './run.js';

test('smoke fails on the runtime error and the missing image, not on the 404 start path', async () => {
	const r = await wdk(['smoke']);
	expect(r.out).toMatch(/✗ chromium \/broken — pageerror: .*boom/);
	expect(r.out).toContain('✗ chromium /broken — 404 /missing.png');
	expect(r.out).not.toContain('/does-not-exist —');
	expect(r.out).not.toContain('Failed to load resource');
	expect(r.out).toContain('4 pages × 1 engine(s), 2 error(s)');
	expect(r.code).toBe(1);
}, 60_000);

test('smoke passes once the broken page is skipped', async () => {
	const r = await wdk(['smoke', '--skip', '^/broken']);
	expect(r.out).toContain('3 pages × 1 engine(s), 0 error(s)');
	expect(r.code).toBe(0);
}, 60_000);

test('smoke exits 2 on invalid engine', async () => {
	const r = await wdk(['smoke', '--engines', 'bogus']);
	expect(r.err).toContain('wdk smoke:');
	expect(r.err).toContain('unknown engine');
	expect(r.code).toBe(2);
});

slow('exe engines report through the beacon and the proxy', async () => {
	const r = await wdk(['smoke', '--engines', 'exe:chrome:$WDK_TEST_CHROME'], { WDK_TEST_CHROME: chromium.executablePath() });
	expect(r.out).toMatch(/✗ exe:chrome:\$WDK_TEST_CHROME \/broken — error: .*boom/);
	expect(r.out).toContain('✗ exe:chrome:$WDK_TEST_CHROME /broken — 404 /missing.png');
	expect(r.out).not.toContain('/does-not-exist —');
	expect(r.code).toBe(1);
}, 120_000);

slow('smoke counts the site console errors, not a third-party embed\'s', async () => {
	const { startProxy } = await import('../lib/proxy.js');
	const { smokeAll } = await import('../lib/cmd/smoke.js');
	const { parseEngine } = await import('../lib/engines.js');
	const html = (body) => new Response(`<!doctype html><html lang="en"><title>t</title>${body}`, { headers: { 'content-type': 'text/html' } });
	const embed = Bun.serve({ port: 0, fetch: () => html('<script>console.error("third party")</script>') });
	const site = Bun.serve({ port: 0, fetch: (r) => new URL(r.url).pathname === '/own' ? html('<script>console.error("mine")</script>') : html(`<iframe title="e" src="http://127.0.0.1:${embed.port}/"></iframe>`) });
	const proxy = startProxy({ origin: `http://localhost:${site.port}` });
	try {
		const { lines } = await smokeAll([parseEngine('chromium')], ['/', '/own'], proxy);
		expect(lines.join('\n')).toContain('/own — console.error: mine');
		expect(lines.join('\n')).not.toContain('third party');
	} finally {
		proxy.stop();
		site.stop(true);
		embed.stop(true);
	}
}, 60_000);

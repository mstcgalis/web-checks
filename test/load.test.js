import { expect, test } from 'bun:test';
import { PROJECT, wdk } from './run.js';

test('load reports LCP and image bytes per page × viewport, the heaviest image named', () => {
	const r = wdk(['load', '--skip', '^/about']);
	expect(r.code).toBe(0);
	expect(r.out).toMatch(/^\/$/m);
	expect(r.out).toMatch(/390×844@3 4G {2}LCP \d+ ms \(plasma\.jpg\) {2}images 1 files \d+ KB · after scroll 1 files/);
	expect(r.out).toMatch(/1280×800@2 {2}LCP \d+ ms/);
	expect(r.out).toMatch(/\d+ KB {2}\/plasma\.jpg/);
}, 120_000);

test('load --cdn times each image via the edge and the origin, and flags what will not cache', async () => {
	// A fake Cloudflare edge: a fixed `cf-cache-status` per image, and one image marked no-store.
	const jpg = await Bun.file(`${PROJECT}/site/plasma.jpg`).arrayBuffer();
	const html = '<!doctype html><html lang="en"><title>t</title><h1>t</h1><img src="/good.jpg" alt="a"><img src="/bad.jpg" alt="b">';
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const { pathname } = new URL(req.url);
			if (pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
			const good = pathname === '/good.jpg';
			return new Response(jpg, {
				headers: {
					'content-type': 'image/jpeg',
					'cf-cache-status': good ? 'HIT' : 'DYNAMIC',
					'cache-control': good ? 'public, max-age=31536000, immutable' : 'no-store',
				},
			});
		},
	});
	try {
		const proc = Bun.spawn(['bun', `${import.meta.dir}/../bin/wdk.js`, 'load', '--cdn', '--url', `http://localhost:${server.port}`, '--skip', '.'], { cwd: PROJECT });
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(out).toMatch(/\/good\.jpg {2}HIT \d+ ms · origin \d+ ms/);
		expect(out).toMatch(/\/bad\.jpg {2}DYNAMIC \d+ ms · origin \d+ ms/);
		expect(out).toContain('! /bad.jpg — not cacheable (cache-control: no-store)');
		expect(out).toContain('! /bad.jpg — second request was DYNAMIC, not HIT');
		expect(out).not.toContain('! /good.jpg');
	} finally {
		server.stop(true);
	}
}, 120_000);

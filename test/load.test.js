import { expect, test } from 'bun:test';
import { PROJECT, wdk, slow } from './run.js';

slow('load reports LCP and image bytes per page × viewport, the heaviest image named', async () => {
	const r = await wdk(['load', '--skip', '^/about']);
	expect(r.code).toBe(0);
	expect(r.out).toMatch(/^\/$/m);
	expect(r.out).toMatch(/390×844@3 4G {2}LCP \d+ ms \(plasma\.jpg\) {2}hero \d+ ms \(plasma\.jpg\) {2}images 1 files \d+ KB · after scroll 1 files/);
	expect(r.out).toMatch(/1280×800@2 {2}LCP \d+ ms/);
	expect(r.out).toMatch(/\d+ KB {2}\/plasma\.jpg/);
}, 120_000);

slow('load --cdn times each image via the edge and the origin, and flags what will not cache', async () => {
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

// A page served by the test itself, measured through --url.
async function loadAgainst(html, extra = []) {
	const jpg = await Bun.file(`${PROJECT}/site/plasma.jpg`).arrayBuffer();
	const server = Bun.serve({
		port: 0,
		fetch: (req) =>
			new URL(req.url).pathname === '/'
				? new Response(html, { headers: { 'content-type': 'text/html' } })
				: new Response(jpg, { headers: { 'content-type': 'image/jpeg' } }),
	});
	try {
		const proc = Bun.spawn(['bun', `${import.meta.dir}/../bin/wdk.js`, 'load', '--url', `http://localhost:${server.port}`, '--skip', '.', ...extra], { cwd: PROJECT });
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		return out.split('/does-not-exist')[0];
	} finally {
		server.stop(true);
	}
}

slow('load waits for a first paint that comes well after the load event', async () => {
	// Nothing contentful until 1.5 s after load: a fixed wait after load read no LCP at all.
	const out = await loadAgainst(
		'<!doctype html><html lang="en"><title>t</title><script>addEventListener("load", () => setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<h1>late</h1>"), 1500))</script><body></body>',
	);
	expect(out).not.toContain('LCP none');
	expect(out).toMatch(/390×844@3 4G {2}LCP \d{4} ms \(<h1> text\)/);
}, 120_000);

slow('load scrolls to the very bottom, past stretches where a step does not move', async () => {
	// An intro that locks scrolling for a second after load: the first wheel step does not move,
	// which ended the old loop at the top. The lazy image sits under a page 30 screens tall.
	const out = await loadAgainst(
		'<!doctype html><html lang="en"><title>t</title><body style="overflow:hidden"><h1>t</h1><div style="height:30000px"></div><img src="/deep.jpg" alt="deep" loading="lazy" width="400" height="300"><script>addEventListener("load", () => setTimeout(() => (document.body.style.overflow = ""), 1000))</script></body>',
	);
	expect(out).toMatch(/390×844@3 4G {2}LCP \d+ ms \(<h1> text\) {2}images 0 files 0 KB · after scroll 1 files/);
	expect(out).toMatch(/1280×800@2 {2}LCP \d+ ms \(<h1> text\) {2}images 0 files 0 KB · after scroll 1 files/);
}, 120_000);

slow('load --slow reports when a full-viewport hero arrives, which LCP leaves out', async () => {
	const out = await loadAgainst(
		'<!doctype html><html lang="en"><title>t</title><body style="margin:0"><h1>t</h1><img src="/hero.jpg" alt="h" style="position:fixed;inset:0;width:100vw;height:100vh;z-index:-1"></body>',
		['--slow'],
	);
	// The phone may count the image (it is not upscaled there); the laptop leaves it out of LCP.
	expect(out).toMatch(/390×844@3 slow {2}LCP \d+ ms \([^)]+\) {2}hero \d+ ms \(hero\.jpg\) {2}images 1 files/);
	expect(out).toMatch(/1280×800@2 slow {2}LCP \d+ ms \(<h1> text\) {2}hero \d+ ms \(hero\.jpg\)/);
}, 120_000);

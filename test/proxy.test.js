import { afterAll, expect, test } from 'bun:test';
import { launch } from '../lib/engines.js';
import { BEACON, blocked, parseOff, rewriteHtml, startProxy } from '../lib/proxy.js';
import { slow } from './run.js';

const knobs = { spin: { css: '.spin{animation:none}', probe: '.spin' }, ticker: { script: 'ticker' } };
const PNG = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255]);
const upstream = Bun.serve({
	port: 0,
	fetch(req) {
		const { pathname, search } = new URL(req.url);
		if (pathname === '/headers') {
			const headerList = [...req.headers.keys()];
			return Response.json(headerList);
		}
		if (pathname === '/search') return Response.json({ search });
		if (pathname === '/redirect') return new Response(null, { status: 302, headers: { location: `http://localhost:${upstream.port}/a` } });
		if (pathname === '/img.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
		if (pathname === '/style.css') return new Response(Bun.gzipSync('a{color:red}'), { headers: { 'content-type': 'text/css', 'content-encoding': 'gzip' } });
		if (pathname === '/hang') return new Promise(() => {});
		if (pathname === '/headless') return new Response('<p>no head</p>', { headers: { 'content-type': 'text/html' } });
		return new Response(`<html><head><title>x</title></head><body><a href="${origin}/a">a</a><script src="/ticker.js?v=1"></script></body></html>`, {
			headers: { 'content-type': 'text/html' },
		});
	},
});
const origin = `http://localhost:${upstream.port}`;
const proxy = startProxy({ origin, knobs, block: ['panel', 'api', '*.php'] });
afterAll(() => {
	proxy.stop();
	upstream.stop(true);
});
const get = (path, init) => fetch(proxy.url + path, init);

test('parseOff: static means every knob; unknown knobs throw', async () => {
	expect(parseOff('static', knobs)).toEqual(['spin', 'ticker']);
	expect(parseOff('', knobs)).toEqual([]);
	expect(() => parseOff('nope', knobs)).toThrow('unknown knob "nope"');
});

test('rewriteHtml: beacon first in head, knob css, script removed, origin rewritten', async () => {
	const html = `<html><head><title>x</title></head><body><a href="http://o/a">a</a><script src="/ticker.js"></script></body></html>`;
	const out = rewriteHtml(html, { knobs, off: ['spin', 'ticker'], origin: 'http://o', self: 'http://p' });
	expect(out.indexOf(BEACON)).toBe(out.indexOf('<head>') + '<head>'.length);
	expect(out).toContain('<style data-wdk>.spin{animation:none}</style></head>');
	expect(out).not.toContain('ticker.js');
	expect(out).toContain('href="http://p/a"');
	expect(() => rewriteHtml('<head></head>', { knobs, off: ['ticker'] })).toThrow('no <script> for ticker.js');
});

test('rewriteHtml: no <head> means the beacon is prepended', async () => {
	expect(rewriteHtml('<p>x</p>', {}).startsWith(BEACON)).toBe(true);
});

test('rewriteHtml: uppercase <HEAD> matches and gets beacon', async () => {
	const html = `<HTML><HEAD><title>x</title></HEAD><body>text</body></HTML>`;
	const out = rewriteHtml(html, {});
	expect(out.indexOf(BEACON)).toBe(out.indexOf('<HEAD>') + '<HEAD>'.length);
});

test('blocked: any decoded, case-folded segment; *.php suffix', async () => {
	for (const p of ['/panel', '/PANEL/x', '/%70anel', '/index.php/panel', '/api/x', '/x.php', '/%zz']) expect(blocked(p, ['panel', 'api', '*.php'])).toBe(true);
	for (const p of ['/', '/panelist', '/about']) expect(blocked(p, ['panel', 'api', '*.php'])).toBe(false);
});

test('proxy: read-only and blocked paths get 403', async () => {
	expect((await get('/panel')).status).toBe(403);
	expect((await get('/%70anel')).status).toBe(403);
	expect((await get('/index.php/panel')).status).toBe(403);
	expect((await get('/', { method: 'POST' })).status).toBe(403);
});

test('proxy: strips method-override headers', async () => {
	const names = await (await get('/headers', { headers: { 'X-HTTP-Method-Override': 'POST', 'X-Method-Override': 'PUT' } })).json();
	expect(names.some((n) => /method-override/i.test(n))).toBe(false);
});

test('proxy: rewrites HTML, passes binaries through byte-identical', async () => {
	const html = await (await get('/?wdk-off=spin')).text();
	expect(html).toContain(BEACON);
	expect(html).toContain('.spin{animation:none}');
	expect(html).toContain(`href="${proxy.url}/a"`);
	expect(new Uint8Array(await (await get('/img.png')).arrayBuffer())).toEqual(PNG);
	expect((await (await get('/headless')).text()).startsWith(BEACON)).toBe(true);
	expect((await get('/?wdk-off=nope')).status).toBe(400);
	expect(proxy.responses.some((r) => r.path === '/img.png' && r.status === 200)).toBe(true);
});

test('proxy: wdk-freeze stops animations; wdk-mouse adds the synthetic pointer', async () => {
	const html = await (await get('/?wdk-freeze&wdk-mouse')).text();
	expect(html).toContain('animation:none!important');
	expect(html).toContain("new MouseEvent('mousemove'");
});

test('proxy: beacon POSTs are recorded', async () => {
	proxy.errors.length = 0;
	expect((await get('/__wdk/beacon', { method: 'POST', body: JSON.stringify({ path: '/x', type: 'error', msg: 'boom' }) })).status).toBe(204);
	expect(proxy.errors).toEqual([{ path: '/x', type: 'error', msg: 'boom' }]);
});

test('proxy: the load beacon records the path, not an error', async () => {
	proxy.errors.length = 0;
	expect((await get('/__wdk/beacon', { method: 'POST', body: JSON.stringify({ path: '/x', type: 'load', msg: '' }) })).status).toBe(204);
	expect(proxy.loads).toContain('/x');
	expect(proxy.errors).toEqual([]);
});

test('proxy: a dead upstream gives 502 and a proxy error', async () => {
	const dead = startProxy({ origin: 'http://127.0.0.1:9' });
	expect((await fetch(dead.url + '/')).status).toBe(502);
	expect(dead.errors[0].type).toBe('proxy');
	dead.stop();
});

test('proxy: header allowlist; blocks cookie, x-forwarded-for, x-http-method', async () => {
	const names = await (await get('/headers', { headers: { 'accept': 'text/html', 'cookie': 'session=123', 'x-forwarded-for': '1.2.3.4', 'x-http-method': 'DELETE', 'authorization': 'Bearer token', 'host': 'example.com' } })).json();
	expect(names).toContain('accept');
	// Check that client-sent headers are not forwarded (note: host is auto-added by Bun, so we check for specific forbidden headers)
	expect(names.some((n) => /cookie|x-forwarded|x-http-method|authorization/i.test(n))).toBe(false);
});

test('proxy: strips _method query param before forwarding', async () => {
	const res = await get('/search?_method=DELETE&foo=bar');
	const { search } = await res.json();
	expect(search).toContain('foo=bar');
	expect(search).not.toContain('_method');
});

test('proxy: rewrites Location header on redirects', async () => {
	const res = await get('/redirect', { redirect: 'manual' });
	expect(res.status).toBe(302);
	expect(res.headers.get('location')).toContain(proxy.url);
	expect(res.headers.get('location')).not.toContain('localhost:' + upstream.port);
});

test('blocked: parser-differential with repeated decode, segment split, trim', async () => {
	const rules = ['panel', 'api', '*.php'];
	// Repeated decode (max 5)
	expect(blocked('/%2570anel', rules)).toBe(true); // %25 = %, so %2570 = %70 = p
	// Segment split on ; and \
	expect(blocked('/panel;x=1', rules)).toBe(true);
	expect(blocked('/x%5Cpanel', rules)).toBe(true); // %5C = \
	// Trailing dots and whitespace trimmed (space is %20)
	expect(blocked('/panel.', rules)).toBe(true);
	expect(blocked('/panel%20', rules)).toBe(true);
	// Double-encoded path segment
	expect(blocked('/x%2fpanel', rules)).toBe(true); // %2f = /
	// Fail closed: 6 rounds of encoding (beyond cap of 5) -> blocked
	expect(blocked('/%252525252570anel', rules)).toBe(true); // Would decode to panel on 6th round
	// Still allow /panelist
	expect(blocked('/panelist', rules)).toBe(false);
});

test('proxy: rejects PUT and DELETE', async () => {
	expect((await get('/', { method: 'PUT' })).status).toBe(403);
	expect((await get('/', { method: 'DELETE' })).status).toBe(403);
});

test('proxy: beacon body size limit and type validation', async () => {
	proxy.errors.length = 0;
	// Valid beacon
	expect((await get('/__wdk/beacon', { method: 'POST', body: JSON.stringify({ path: '/x', type: 'error', msg: 'ok' }) })).status).toBe(204);
	expect(proxy.errors.length).toBe(1);
	// Invalid type
	proxy.errors.length = 0;
	expect((await get('/__wdk/beacon', { method: 'POST', body: JSON.stringify({ path: '/x', type: 'invalid', msg: 'fail' }) })).status).toBe(204);
	expect(proxy.errors.length).toBe(0);
	// null body is not recorded
	proxy.errors.length = 0;
	expect((await get('/__wdk/beacon', { method: 'POST', body: JSON.stringify({ path: '/x', type: null, msg: 'null' }) })).status).toBe(204);
	expect(proxy.errors.length).toBe(0);
	// Body over 4 KB is ignored
	proxy.errors.length = 0;
	const bigBody = JSON.stringify({ path: '/x', type: 'error', msg: 'x'.repeat(5000) });
	expect((await get('/__wdk/beacon', { method: 'POST', body: bigBody })).status).toBe(204);
	expect(proxy.errors.length).toBe(0);
});

test('a gzipped non-HTML response reaches the client intact', async () => {
	const res = await fetch(`${proxy.url}/style.css`, { headers: { 'accept-encoding': 'identity' } });
	expect(await res.text()).toBe('a{color:red}');
});

test('an upstream that never answers times out as a 504 and an error', async () => {
	const slow = startProxy({ origin, upstreamTimeout: 200 });
	const res = await fetch(`${slow.url}/hang`);
	expect(res.status).toBe(504);
	expect(slow.errors.at(-1).msg).toContain('timed out');
	slow.stop();
});

slow('the beacon names the file and line of a script error', async () => {
	const site = Bun.serve({ port: 0, fetch: (r) => new URL(r.url).pathname === '/bad.js'
		? new Response('\n@x', { headers: { 'content-type': 'text/javascript' } })
		: new Response('<html><head><script src="/bad.js"></script></head></html>', { headers: { 'content-type': 'text/html' } }) });
	const p = startProxy({ origin: `http://localhost:${site.port}` });
	const browser = await launch('chromium');
	try {
		await (await browser.newPage()).goto(p.url + '/');
		for (let i = 0; i < 50 && !p.errors.length; i++) await Bun.sleep(50);
		expect(p.errors[0].msg).toEndWith('(/bad.js:2)');
	} finally {
		await browser.close();
		p.stop();
		site.stop(true);
	}
}, 30_000);

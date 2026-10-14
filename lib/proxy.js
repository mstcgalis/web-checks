// The rewriting proxy every browser-facing command goes through. Each variant
// is a URL, which is what lets a browser the wdk cannot drive (FF115, a phone
// on the LAN) take part:
//   ?wdk-off=a,b|static   perf knobs off (wdk.config.js perf.knobs)
//   ?wdk-mouse            synthetic pointer, for browsers with no driver
//   ?wdk-freeze           every animation and transition off, for screenshots
// Every HTML page also gets BEACON first in <head>: runtime errors POST back
// to /__wdk/beacon, so any browser reports them.

// ES5 on purpose: it has to run in the oldest engine anyone points at it.
export const BEACON =
	"<script>(function(){function s(t,m){try{var x=new XMLHttpRequest();x.open('POST','/__wdk/beacon',true);x.send(JSON.stringify({path:location.pathname,type:t,msg:String(m)}))}catch(e){}}" +
	"addEventListener('error',function(e){var t=e.target;if(t&&t!==window){s('resource',t.src||t.href||t.tagName)}else{s('error',e.message)}},true);" +
	"addEventListener('unhandledrejection',function(e){s('rejection',e.reason&&e.reason.message||e.reason)});" +
	"addEventListener('load',function(){setTimeout(function(){s('load','')},500)});" +
	"var c=console.error;console.error=function(){s('console',[].join.call(arguments,' '));return c.apply(console,arguments)}})()</script>";

const FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important}';
const FAKE_MOUSE =
	"<script>setInterval(function(){window.dispatchEvent(new MouseEvent('mousemove',{clientX:innerWidth*Math.random(),clientY:innerHeight*Math.random(),movementX:20,movementY:20}))},16)</script>";

export function parseOff(value, knobs) {
	if (value === 'static') return Object.keys(knobs);
	const off = value ? value.split(',').filter(Boolean) : [];
	for (const name of off) {
		if (!knobs[name]) throw new Error(`unknown knob "${name}" — known: ${Object.keys(knobs).join(', ')}`);
	}
	return off;
}

export function rewriteHtml(html, { knobs = {}, off = [], mouse = false, freeze = false, beacon = true, origin, self }) {
	let out = origin && self ? html.replaceAll(origin, self) : html;
	if (beacon) out = /<head(\s[^>]*)?>/i.test(out) ? out.replace(/<head(\s[^>]*)?>/i, (head) => head + BEACON) : BEACON + out;
	for (const name of off) {
		const { script } = knobs[name];
		if (!script) continue;
		const re = new RegExp(`<script[^>]*src="[^"]*/${script}\\.js[^"]*"[^>]*></script>`);
		if (!re.test(out)) throw new Error(`knob "${name}": no <script> for ${script}.js on this page`);
		out = out.replace(re, '');
	}
	const css = off.map((name) => knobs[name].css).filter(Boolean).join('') + (freeze ? FREEZE : '');
	if (css) out = out.replace('</head>', () => `<style data-wdk>${css}</style></head>`);
	if (mouse) out = out.replace('</body>', () => FAKE_MOUSE + '</body>');
	return out;
}

// Any segment, decoded and case-folded: /PANEL, /%70anel and /index.php/panel
// all reach a Kirby Panel. Undecodable paths are blocked outright.
// Parser-differential: decode repeatedly (max 5 rounds), split on /, \, ;, trim dots/space.
// Fail closed: if path still changes after 5 decodes, it might decode further, so block it.
export function blocked(pathname, block) {
	let decoded = pathname;
	for (let i = 0; i < 5; i++) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			return true;
		}
	}
	// If we exited loop at iteration 5 and path would still decode, fail closed
	try {
		const stillChanges = decodeURIComponent(decoded) !== decoded;
		if (stillChanges) return true;
	} catch {
		return true;
	}
	const segments = decoded.toLowerCase().split(/[/\\;]/).map((s) => s.replace(/[\s.]*$/, ''));
	return segments.some((s) => block.some((b) => (b.startsWith('*') ? s.endsWith(b.slice(1)) : s === b)));
}

export function startProxy(options) {
	const { origin, knobs = {}, block = [], port = 0, hostname = '127.0.0.1', upstreamTimeout = 20_000 } = options;
	const errors = [];
	const responses = [];
	const loads = []; // paths whose load event fired (plus a 500ms settle)
	const ALLOWED_HEADERS = new Set(['accept', 'accept-language', 'user-agent', 'range', 'if-none-match', 'if-modified-since', 'cache-control']);
	const server = Bun.serve({
		port,
		hostname,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/__wdk/beacon' && req.method === 'POST') {
				try {
					const text = await req.text();
					if (text.length > 4096) return new Response(null, { status: 204 });
					const data = JSON.parse(text);
					if (data.type === 'load') loads.push(data.path) > 1000 && loads.shift();
					else if (['error', 'resource', 'rejection', 'console'].includes(data.type)) {
						if (errors.length < 1000) errors.push(data);
					}
				} catch {}
				return new Response(null, { status: 204 });
			}
			// The proxy may face the LAN (perf --serve), and dev servers often trust
			// localhost: pages only, read-only.
			if (!['GET', 'HEAD'].includes(req.method) || blocked(url.pathname, block)) {
				return new Response('wdk proxy: read-only, blocked path', { status: 403 });
			}
			let off;
			try {
				off = parseOff(url.searchParams.get('wdk-off') ?? '', knobs);
			} catch (e) {
				return new Response(e.message, { status: 400 });
			}
			const mouse = url.searchParams.has('wdk-mouse');
			const freeze = url.searchParams.has('wdk-freeze');
			for (const p of ['wdk-off', 'wdk-mouse', 'wdk-freeze', '_method']) url.searchParams.delete(p);
			const headers = new Headers();
			for (const [name, value] of req.headers) {
				if (ALLOWED_HEADERS.has(name.toLowerCase())) {
					headers.set(name, value);
				}
			}
			let res;
			try {
				// Cancel upstream when the browser gives up on the request, so abandoned
				// requests don't queue on a single-threaded origin (php -S).
				const signal = AbortSignal.any([req.signal, AbortSignal.timeout(upstreamTimeout)]);
				res = await fetch(origin + url.pathname + url.search, { method: req.method, headers, redirect: 'manual', signal });
			} catch (e) {
				if (e.name === 'TimeoutError') {
					errors.push({ path: url.pathname, type: 'proxy', msg: `${url.pathname} timed out after ${upstreamTimeout}ms` });
					return new Response('wdk proxy: upstream timed out', { status: 504 });
				}
				if (req.signal.aborted) return new Response(null, { status: 499 }); // the browser left; nobody reads this
				errors.push({ path: url.pathname, type: 'proxy', msg: `${origin} unreachable: ${e.message}` });
				return new Response(`wdk proxy: ${origin} unreachable`, { status: 502 });
			}
			// Bounded for long perf --serve sessions; smoke clears it per page anyway.
			if (responses.push({ path: url.pathname, status: res.status }) > 1000) responses.shift();
			// Rewrite Location header on redirects
			if ((res.status >= 300 && res.status < 400) && res.headers.get('location')) {
				res.headers.set('location', res.headers.get('location')?.replaceAll(origin, url.origin) ?? '');
			}
			// fetch() has already decoded the body; the upstream's encoding headers would lie.
			const out = new Headers(res.headers);
			out.delete('content-length');
			out.delete('content-encoding');
			if (!(res.headers.get('content-type') ?? '').includes('text/html')) return new Response(res.body, { status: res.status, headers: out });
			let html;
			try {
				html = rewriteHtml(await res.text(), { knobs, off, mouse, freeze, origin, self: url.origin });
			} catch (e) {
				return new Response(e.message, { status: 400 });
			}
			return new Response(html, { status: res.status, headers: out });
		},
	});
	return { url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${server.port}`, port: server.port, errors, responses, loads, stop: () => server.stop(true),
		// The same proxy on a port of its own, with a log of its own.
		another: () => startProxy({ ...options, port: 0 }) };
}

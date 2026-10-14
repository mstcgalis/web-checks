// The project's own server, through the contract's `just serve-at PORT`, and a
// crawl of it. Commands never know the stack; this file is why.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

export async function freePort() {
	const probe = Bun.serve({ hostname: 'localhost', port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	return port;
}

// freePort() can lose its port to another process before serve-at binds it;
// serve-at then exits (even if the thief answers), so a fresh port gets a couple more tries.
export async function startSite(tries = 3) {
	for (let i = 1; ; i++) {
		try {
			return await startSiteOnce(i >= tries);
		} catch (e) {
			if (i >= tries || !e.exited) throw e;
		}
	}
}

async function startSiteOnce(last) {
	const port = await freePort();
	// detached: the recipe's shell is the group leader, so one kill takes the real server too.
	const child = spawn('just', ['serve-at', String(port)], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
	let exited = false;
	let stopped = false;
	let running = false;
	// The server's stderr is held, never streamed: before it answers, just's recipe echo and
	// startup chatter; after, access logs and dropped connections. All noise unless it never
	// answers, or dies mid-run (then its last lines say why); never after our own kill.
	let held = [];
	child.stderr.on('data', (d) => held.push(d) > 20 && running && held.shift());
	const flush = () => {
		for (const d of held) process.stderr.write(d);
		held = [];
	};
	child.on('exit', () => (exited = true));
	// 'close', not 'exit': it comes after the last stderr.
	child.on('close', () => {
		if (!running || stopped) return;
		process.stderr.write('wdk: `just serve-at` exited mid-run; its last output:\n');
		flush();
	});
	child.on('error', () => (exited = true));
	const origin = `http://localhost:${port}`;
	const stop = () => {
		stopped = true;
		try {
			process.kill(-child.pid);
		} catch {}
	};
	const deadline = Date.now() + 10_000;
	for (;;) {
		// Whoever took freePort()'s port first answers too; our serve-at then dies on bind, so
		// an answer only counts once serve-at has outlived it a moment. A server that accepts
		// but never answers must not hang the probe past the deadline.
		const answered = await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
		if (answered && (await Bun.sleep(300), !exited)) {
			held = [];
			running = true;
			return { origin, stop };
		}
		if (exited || Date.now() > deadline) {
			// Let the exit's last stderr arrive before deciding what to show.
			await Bun.sleep(50);
			if (last || !exited) flush();
			stop();
			const hint = 'the justfile needs `serve-at PORT`, a foreground server on PORT (run `wdk doctor`)';
			throw Object.assign(new Error(`\`just serve-at ${port}\` ${exited ? 'exited' : 'never answered'} on ${origin} — ${hint}`), { exited });
		}
		await Bun.sleep(100);
	}
}

// Every same-origin page reachable from pages.start, by pathname. Links come
// from the served HTML (HTMLRewriter), not a browser: crawling is the same for
// every engine, so it happens once.
export async function crawl(origin, { start, skip, limit }, timeout = 20_000) {
	let skipRe;
	try {
		skipRe = new RegExp(skip ? `${skip}|\\.\\w+$` : '\\.\\w+$');
	} catch {
		throw new Error(`pages.skip / --skip ${JSON.stringify(skip)} is not a valid regex`);
	}
	const queue = [...start];
	const seen = new Set(queue);
	// Breadth-first, a level at a time: the level's pages are fetched side by side, their links
	// taken in queue order, so the result is the same as a one-at-a-time crawl.
	for (let level = 0; level < queue.length; ) {
		const pages = queue.slice(level);
		level = queue.length;
		const hrefs = new Map();
		await eachPage(pages, async (path) => void hrefs.set(path, await links(origin + path, timeout)));
		for (const path of pages) {
			for (const href of hrefs.get(path)) {
				let url;
				try {
					url = new URL(href, origin + path);
				} catch {
					continue;
				}
				if (url.origin !== origin || skipRe.test(url.pathname) || seen.has(url.pathname) || seen.size >= limit) continue;
				seen.add(url.pathname);
				queue.push(url.pathname);
			}
		}
	}
	return queue;
}

// A page's hrefs; none when it is not HTML or does not answer (smoke reports that page).
async function links(url, timeout) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
		if (!(res.headers.get('content-type') ?? '').includes('text/html')) return [];
		const hrefs = [];
		await new HTMLRewriter().on('a[href]', { element: (a) => void hrefs.push(a.getAttribute('href')) }).transform(res).text();
		return hrefs;
	} catch {
		return [];
	}
}

// Pages side by side: half the cores, 2–6 at a time. Workers share one iterator.
export const WORKERS = Math.max(2, Math.min(6, availableParallelism() >> 1));
export async function eachPage(paths, fn, n = WORKERS) {
	const queue = paths.values();
	await Promise.all(Array.from({ length: Math.min(n, paths.length) }, async () => {
		for (const path of queue) await fn(path);
	}));
}

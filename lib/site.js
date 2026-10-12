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
	child.on('exit', () => (exited = true));
	child.on('error', () => (exited = true));
	// The server's stderr, held until it answers: shown only if it never does (just's echo of
	// the recipe line and startup chatter are noise), then streamed; never after our own kill
	// (just's "terminated by signal 15").
	let held = [];
	child.stderr.on('data', (d) => (held ? held.push(d) : stopped || process.stderr.write(d)));
	const flush = (show = true) => {
		if (show) for (const d of held ?? []) process.stderr.write(d);
		held = null;
	};
	const origin = `http://localhost:${port}`;
	const stop = () => {
		stopped = true;
		try {
			process.kill(-child.pid);
		} catch {}
	};
	for (let i = 0; ; i++) {
		// Whoever took freePort()'s port first answers too; our serve-at then dies on bind, so
		// an answer only counts once serve-at has outlived it a moment.
		if ((await fetch(origin).then(() => true, () => false)) && (await Bun.sleep(300), !exited)) {
			flush(false);
			return { origin, stop };
		}
		if (exited || i > 100) {
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
export async function crawl(origin, { start, skip, limit }) {
	const skipRe = new RegExp(skip ? `${skip}|\\.\\w+$` : '\\.\\w+$');
	const queue = [...start];
	const seen = new Set(queue);
	for (const path of queue) {
		const res = await fetch(origin + path);
		if (!(res.headers.get('content-type') ?? '').includes('text/html')) continue;
		const hrefs = [];
		await new HTMLRewriter().on('a[href]', { element: (a) => void hrefs.push(a.getAttribute('href')) }).transform(res).text();
		for (const href of hrefs) {
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
	return queue;
}

// Pages side by side: half the cores, 2–6 at a time. Workers share one iterator.
export const WORKERS = Math.max(2, Math.min(6, availableParallelism() >> 1));
export async function eachPage(paths, fn, n = WORKERS) {
	const queue = paths.values();
	await Promise.all(Array.from({ length: Math.min(n, paths.length) }, async () => {
		for (const path of queue) await fn(path);
	}));
}

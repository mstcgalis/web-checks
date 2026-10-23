// wdk update [--tag vX.Y.Z [--sha SHA]]: move a project to the latest wdk release. Pins the wdk's reusable
// workflows in .github/workflows to the release commit (`@SHA # vX.Y.Z`: a moved tag can't change what runs
// with a deploy key) and rewrites a tag-pinned `inputs.wdk` in flake.nix (flake.lock pins its rev), then
// `nix flake update wdk`. Nothing is committed: the diff is yours (CI's update.yml opens a PR).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const REPO = 'https://github.com/mstcgalis/web-dev-kit';
const WORKFLOW = /(mstcgalis\/web-dev-kit\/\.github\/workflows\/[\w-]+\.yml@)(?:[0-9a-f]{40} # )?v[\d.]+/g;
const FLAKE = /(github:mstcgalis\/web-dev-kit\/)v[\d.]+/g;

export const repin = (text, tag, sha) => text.replace(WORKFLOW, `$1${sha} # ${tag}`).replace(FLAKE, `$1${tag}`);

// The newest release tag (or `tag`) and its commit. Lightweight tags; a peeled `^{}` line wins if annotated.
export function release(tag) {
	const r = Bun.spawnSync(['git', 'ls-remote', '--tags', '--sort=-v:refname', REPO, tag ?? 'v*'], { stderr: 'pipe' });
	const rows = r.stdout.toString().trim().split('\n').filter(Boolean).map((l) => l.split(/\s+refs\/tags\//));
	const name = rows.find(([, n]) => !n.endsWith('^{}'))?.[1];
	if (!name) throw new Error(`no release tag ${tag ?? ''} at ${REPO} (${r.stderr.toString().trim() || 'no network or no access'}); pass --tag vX.Y.Z --sha SHA`);
	const sha = (rows.find(([, n]) => n === `${name}^{}`) ?? rows.find(([, n]) => n === name))[0];
	return { tag: name, sha };
}

export async function run(args) {
	const { values } = parseArgs({ args, options: { tag: { type: 'string' }, sha: { type: 'string' } } });
	if (values.sha && !values.tag) throw new Error('--sha needs --tag');
	const { tag, sha } = values.sha ? { tag: values.tag, sha: values.sha } : release(values.tag);
	const files = ['flake.nix', ...(existsSync('.github/workflows') ? readdirSync('.github/workflows').map((f) => `.github/workflows/${f}`) : [])];
	for (const f of files) {
		let before;
		try {
			before = readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		const after = repin(before, tag, sha);
		if (after !== before) (writeFileSync(f, after), console.log(`${f} -> ${tag}`));
	}
	const lock = Bun.spawnSync(['nix', 'flake', 'update', 'wdk'], { stdio: ['inherit', 'inherit', 'inherit'] });
	if (lock.exitCode) throw new Error('`nix flake update wdk` failed (is this a flake project? is nix installed?)');
	return 0;
}

// wdk update [--tag vX.Y.Z]: move a project to the latest wdk release. Rewrites the `@vX` of the
// wdk's reusable workflows in .github/workflows and a tag-pinned `inputs.wdk` in flake.nix, then
// `nix flake update wdk`. Nothing is committed: the diff is yours (CI's update.yml opens a PR).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const REPO = 'https://github.com/mstcgalis/web-dev-kit';
const PINS = [
	/(mstcgalis\/web-dev-kit\/\.github\/workflows\/[\w-]+\.yml@)v[\d.]+/g,
	/(github:mstcgalis\/web-dev-kit\/)v[\d.]+/g,
];

export const repin = (text, tag) => PINS.reduce((t, re) => t.replace(re, `$1${tag}`), text);

function latestTag() {
	const r = Bun.spawnSync(['git', 'ls-remote', '--tags', '--refs', '--sort=-v:refname', REPO, 'v*'], { stderr: 'pipe' });
	const tag = r.stdout.toString().split('\n')[0]?.split('refs/tags/')[1];
	if (!tag) throw new Error(`no release tag found at ${REPO} (${r.stderr.toString().trim() || 'no network or no access'}); pass --tag vX.Y.Z`);
	return tag;
}

export async function run(args) {
	const { values } = parseArgs({ args, options: { tag: { type: 'string' } } });
	const tag = values.tag ?? latestTag();
	const files = ['flake.nix', ...(existsSync('.github/workflows') ? readdirSync('.github/workflows').map((f) => `.github/workflows/${f}`) : [])];
	for (const f of files) {
		let before;
		try {
			before = readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		const after = repin(before, tag);
		if (after !== before) (writeFileSync(f, after), console.log(`${f} -> ${tag}`));
	}
	const lock = Bun.spawnSync(['nix', 'flake', 'update', 'wdk'], { stdio: ['inherit', 'inherit', 'inherit'] });
	if (lock.exitCode) throw new Error('`nix flake update wdk` failed (is this a flake project? is nix installed?)');
	return 0;
}

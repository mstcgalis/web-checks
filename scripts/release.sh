#!/usr/bin/env bash
# just release X.Y.Z: every test, bump, tag, push, lock the templates; then move each project
# listed in .release-projects (one path per line, gitignored) to the release and push it.
# A project push deploys it. A project whose pin files have uncommitted edits is skipped.
set -euo pipefail
v=${1:?usage: just release X.Y.Z}
tag=v$v
cd "$(dirname "$0")/.."
[ "$(git branch --show-current)" = web-kit ] || { echo "release from web-kit"; exit 1; }
git diff --quiet HEAD || { echo "commit or stash first"; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "$tag exists"; exit 1; }
command -v nix >/dev/null || { echo "nix not on PATH (wdk update needs it): run from the dev shell"; exit 1; }

log=$(mktemp)
bun test --parallel >"$log" 2>&1 || { tail -40 "$log"; echo "tests failed, nothing released"; exit 1; }

sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$v\"/" package.json && rm package.json.bak
git commit -qm "chore(release): $tag" -- package.json
git fetch -q . web-kit:main # fast-forward only
git tag "$tag" main
git push -q origin main web-kit "$tag"
sha=$(git rev-parse "$tag^{commit}")

for t in templates/*/; do (cd "$t" && bun ../../bin/wdk.js update --tag "$tag" --sha "$sha" >/dev/null); done
git add templates
git commit -qm "chore(templates): lock wdk $tag"
git fetch -q . web-kit:main
git push -q origin main web-kit
echo "✓ wdk $tag released, templates locked"

[ -f .release-projects ] || exit 0
pins=(flake.nix flake.lock .github/workflows)
while read -r p; do
	p=${p/#\~/$HOME}
	[ -n "$p" ] || continue
	if ! git -C "$p" diff --quiet HEAD -- "${pins[@]}"; then echo "! $p: pin files have uncommitted edits, skipped"; continue; fi
	(cd "$p" && bun "$OLDPWD/bin/wdk.js" update --tag "$tag" --sha "$sha" >/dev/null)
	git -C "$p" add -- "${pins[@]}"
	git -C "$p" commit -qm "chore(deps): wdk $tag" -- "${pins[@]}"
	git -C "$p" push -q
	echo "✓ $p on $tag, pushed"
done <.release-projects

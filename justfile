# list recipes
default:
    @just --list

# fast tests (skips the browser-heavy end-to-end ones): before every commit
check:
    WDK_FAST=1 bun test --parallel

# every test, as CI runs them: before a release
check-all:
    bun test --parallel

# the node_modules hash after a bun.lock change
hash:
    nix build .#node-modules 2>&1 | grep 'got:' || echo "hash unchanged"

# after pushing a release tag: point the templates' workflow pins and flake.lock at it, so new projects get this wdk
lock-templates:
    for t in templates/*/; do (cd "$t" && bun ../../bin/wdk.js update); done

# test, tag, push, lock templates, re-pin and push the projects in .release-projects (pushes deploy)
release VERSION:
    scripts/release.sh {{VERSION}}

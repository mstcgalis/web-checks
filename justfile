# list recipes
default:
    @just --list

# fast tests (skips the browser-heavy end-to-end ones): before every commit
check:
    WDK_FAST=1 bun test

# every test, as CI runs them: before a release
check-all:
    bun test

# the node_modules hash after a bun.lock change
hash:
    nix build .#node-modules 2>&1 | grep 'got:' || echo "hash unchanged"

# after pushing a release to main: point the templates' flake.lock at it, so new projects get this wdk
lock-templates:
    for t in templates/*/flake.lock; do (cd "$(dirname "$t")" && nix flake update wdk); done

<?php

// css()/js() URLs get `?v=<content hash>`, so assets can be served immutable. A hash, not
// an mtime: extraction and hardlinks reset mtimes on every release.
$version = function (Kirby\Cms\App $kirby, string $url): string {
    static $seen = [];
    $file = $kirby->root('index') . '/' . ltrim($url, '/');
    return $seen[$url] ??= is_file($file) ? $url . '?v=' . substr(hash_file('xxh128', $file), 0, 12) : $url;
};

Kirby::plugin('wdk/assets', ['components' => ['css' => $version, 'js' => $version]]);

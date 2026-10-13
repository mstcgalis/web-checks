<?php

// `php -S` router for wdk checks: kirby/router.php, but rendering tests/content, so checks
// never depend on a local copy of the server-owned content/.
$root = dirname(__DIR__);
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/';
if ($path !== '/' && is_file($root . urldecode($path))) {
    return false;
}
$_SERVER['SCRIPT_NAME'] = '/index.php';

require $root . '/vendor/autoload.php';

echo (new Kirby(['roots' => ['index' => $root, 'content' => __DIR__ . '/content']]))->render();

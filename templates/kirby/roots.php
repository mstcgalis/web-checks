<?php

// Kirby roots for a release deploy: the release is read-only code, everything Kirby
// writes lives under KIRBY_SHARED (set by the PHP-FPM pool). Unset, Kirby's defaults apply.
$shared = getenv('KIRBY_SHARED');

return $shared ? array_combine(
    $names = ['content', 'media', 'accounts', 'sessions', 'cache', 'logs', 'license'],
    array_map(fn (string $n) => "$shared/$n", $names)
) : [];

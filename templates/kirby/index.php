<?php

require __DIR__ . '/vendor/autoload.php';

echo (new Kirby(['roots' => require __DIR__ . '/roots.php']))->render();

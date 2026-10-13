<!doctype html>
<html lang="<?= esc($kirby->language()?->code() ?? 'en', 'attr') ?>">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= esc($page->title()->value()) ?> | <?= esc($site->title()->value()) ?></title>
  <?= css('assets/css/style.css') ?>
</head>
<body>
  <main>
    <h1><?= $page->title()->html() ?></h1>
    <?= $page->text()->kt() ?>
  </main>
</body>
</html>

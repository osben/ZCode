# Gen UI vendor assets

## Поведение

Vendored-файлы Gen UI являются фиксированным снимком: их байты должны оставаться
неизменными при checkout на любой поддерживаемой ОС. SHA-256 каждого файла
проверяется по `assets/vendor/manifest.json` до копирования в runtime assets.
Git не должен автоматически преобразовывать окончания строк в этом каталоге.

## Приёмка

- Windows checkout сохраняет исходные байты файлов `assets/vendor/`.
- Проверка хешей в `packages/desktop/scripts/gen-ui-runtime-assets.mjs` проходит
  для vendored-файлов без изменения manifest.

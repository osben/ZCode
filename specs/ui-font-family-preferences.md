# UI font family preferences

## Product rules

- Bundled and installed font family names are matched case-insensitively, consistent with CSS family matching.
- A custom font is tried first, then the corresponding bundled default, then the platform and generic fallback stack.
- The font picker's localized Default option is searchable by the text shown to the user; selecting it clears the override.
- Font descriptions use natural wording in each supported locale.

## Acceptance scenarios

| Scenario                                                                | Expected result                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A saved family differs from an installed or bundled family only by case | It is treated as available and is not marked stale.                          |
| A custom family lacks a glyph present in the bundled family             | Rendering falls through to the bundled family before platform fallbacks.     |
| The user searches the font picker for the localized Default label       | The default option remains available and selecting it clears the preference. |
| Ukrainian font descriptions describe the built-in default               | They use the natural phrase “шрифт за замовчуванням”.                        |

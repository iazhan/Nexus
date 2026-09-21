# i18n Package Context

## Domain
Internationalization and localization.

## Responsibilities
- Load and parse locale dictionaries (`zh-CN`, `en-US`).
- Expose the `t()` function and React `useLocale()` hook.
- Support runtime locale switching without full page reloads.

## Ubiquitous Language
- **LocaleKey**: The strongly typed string keys for translations.
- **LocaleManager**: Core singleton managing the active language and emitting events.
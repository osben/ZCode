# Windows JetBrains editor detection

Windows editor detection supports JetBrains installations under `%LOCALAPPDATA%\Programs` in both layouts:

- Stable per-product directories such as `IntelliJ IDEA Ultimate\bin\idea64.exe`, matched by product-directory prefix.
- Legacy Toolbox directories under `JetBrains\Toolbox\apps\<app-code>\ch-<channel>\<version>\bin`.

When multiple candidates exist, the resolver uses the first installed executable in its candidate order. Keep coverage for both layouts so adding support for one does not regress the other.

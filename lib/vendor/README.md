# Vendored dependencies

## `qrcode.mjs`

- **Project:** qrcode.js (QR Code generator for JavaScript)
- **Author:** Kazuhiko Arase
- **Upstream:** <https://github.com/kazuhikoarase/qrcode-generator>
- **Licence:** MIT — see the header of `qrcode.mjs` for the full text
- **Vendored on:** 2026-11-04
- **Why vendored:** the plugin only needs a QR encoder, and adding a package
  dependency for ~50 KB of stable MIT-licensed code would make the plugin
  resolve a new dependency tree on every host. Vendoring also pins the exact
  bytes so the pairing QR cannot change under us.
- **Modifications:** none. The file is a verbatim copy of the upstream single
  file build (`qrcode.mjs`), exported as `qrcode` (named and default).
- **Updating:** replace `qrcode.mjs` with the new upstream file, keep the
  `export const qrcode` / `export default qrcode` tail, and re-check
  `node --check lib/vendor/qrcode.mjs`. Nothing in the plugin patches it.

Only the encoder API is used: `qrcode(typeNumber, errorCorrectionLevel)`,
`addData`, `make`, `getModuleCount`, `isDark`.

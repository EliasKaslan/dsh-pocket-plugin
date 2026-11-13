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
- **Modifications:** none — byte-for-byte identical to the upstream single-file
  build `js/dist/qrcode.mjs` (sha256
  `ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0`, 51,907 bytes,
  re-checked 2026-11-13 against upstream `master`). The exports are the upstream
  file's own: `export const qrcode` (line 27), `export default qrcode`, and
  `export const stringToBytes`. The plugin imports the default export.
- **Updating:** replace `qrcode.mjs` with the new upstream `js/dist/qrcode.mjs`
  wholesale — do not hand-edit it and do not append exports (they ship with the
  upstream file). Then re-check `node --check lib/vendor/qrcode.mjs`.
  Nothing in the plugin patches it.

Only the encoder API is used: `qrcode(typeNumber, errorCorrectionLevel)`,
`addData`, `make`, `getModuleCount`, `isDark`.

# TypeScript LSP

Declares the `typescript` language server (`typescript-language-server --stdio`) for `.ts`, `.tsx`,
`.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, and `.cjs` files. This plugin contains no code of its own:
the server runs only when its binary is found on `PATH`.

## Install the server

```sh
npm install -g typescript-language-server typescript
```

`typescript` must be installed alongside the server, because `typescript-language-server` loads the
TypeScript compiler from the workspace or from the global install. It needs a TypeScript that ships
`lib/tsserver.js` (TypeScript 5 or 6); TypeScript 7 no longer does, so for a global install use
`npm install -g typescript@6`. Workspaces with their own `typescript` dependency use that one. Verify
the install with:

```sh
typescript-language-server --version
```

If the binary is missing, the plugin stays inert and reports no errors in chat.

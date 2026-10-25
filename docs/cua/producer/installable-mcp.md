# Installable MCP package

> DEPRECATED as an install guide. The Python MCP server (`uvx --from zcode-cua[macos]@<wheel>`,
> private-PyPI / file-share flows, `scripts/package_mcp_distribution.py`) is removed. The canonical CUA MCP
> tool is the TypeScript package **@zcode/zcode-cua** (npm); source and the product/broker install profiles
> live in the z-code repo. Linux/AT-SPI is handled by the same package.

```bash
npm install @zcode/zcode-cua
# or, without installing:
npx @zcode/zcode-cua
```

STDIO is the default transport; local Streamable HTTP is available explicitly:

```bash
npx @zcode/zcode-cua --transport streamable-http --host 127.0.0.1 --port 8001
```

The MCP endpoint is `http://127.0.0.1:8001/mcp`.

This repo still hosts the real-model act-verify harness, the canonical skill and the screenshot-pipeline
parity fixtures (see the top-level `README.md`). Full history: the commit before
`refactor/deprecate-python`.

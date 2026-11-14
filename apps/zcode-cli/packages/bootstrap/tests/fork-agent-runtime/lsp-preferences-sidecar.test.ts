// Fork: the language-server preferences sidecar is shared by the Node and Rust agents
// (specs/fork-rust-lsp.md, acceptance 2). The Rust store's test writes the same patch sequence and
// asserts the same golden bytes, so both writers agree without either running the other's toolchain.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LSP_PREFERENCES_FILE_NAME, LspPreferencesSchema } from "@zcode/contracts";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createLspPreferencesStore } from "../../src/app/lsp-preferences.js";

const GOLDEN = fileURLToPath(
  new URL(
    "../../../../../../packages/rust-cli/crates/cli/src/lsp/fixtures/fork_lsp_preferences.json",
    import.meta.url,
  ),
);

/** The sequence the Rust test `the_patch_sequence_writes_the_golden_sidecar` applies. */
const PATCHES = [
  { diagnosticsAfterEdit: { "a@m/x": false, "b@m/y": true } },
  { enabled: false, diagnosticsAfterEdit: { "a@m/x": null, "q@m/\"ü\"": true, "b@m/y": false } },
  { diagnosticsAfterEdit: { "c@m/z": false } },
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fork-lsp-sidecar-"));
  roots.push(root);
  return join(root, "cli");
}

describe("fork_lsp_preferences.json shared with the Rust agent", () => {
  it("the golden sidecar parses under the strict schema", async () => {
    const golden = await readFile(GOLDEN, "utf8");
    expect(LspPreferencesSchema.safeParse(JSON.parse(golden)).success).toBe(true);
  });

  it("the Node store writes the golden bytes for the shared patch sequence", async () => {
    const cliStorageRoot = await storageRoot();
    const store = createLspPreferencesStore({
      cliStorageRoot,
      fileSystem: createNodeFileSystemAdapter(),
    });
    for (const patch of PATCHES) await store.update(patch);
    const written = await readFile(join(cliStorageRoot, LSP_PREFERENCES_FILE_NAME), "utf8");
    expect(written).toBe(await readFile(GOLDEN, "utf8"));
  });

  it("the Node store reads the golden sidecar unchanged", async () => {
    const cliStorageRoot = await storageRoot();
    const fileSystem = createNodeFileSystemAdapter();
    await createLspPreferencesStore({ cliStorageRoot, fileSystem }).update({});
    await writeFile(
      join(cliStorageRoot, LSP_PREFERENCES_FILE_NAME),
      await readFile(GOLDEN, "utf8"),
    );
    const loaded = await createLspPreferencesStore({ cliStorageRoot, fileSystem }).load();
    // Serialized, so the override key order counts too (`toEqual` ignores it).
    expect(`${JSON.stringify(loaded, null, 2)}\n`).toBe(await readFile(GOLDEN, "utf8"));
  });
});

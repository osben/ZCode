import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import win32 from "node:path/win32";
import posix from "node:path/posix";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer, isInsideDirectory, isPathDriveQualified } from "../src/http.js";
import { listeningAddress } from "./listeningAddress.js";

// Background: on Windows, path.resolve('C:\\web', 'Z:/x') switches to drive Z directly. Cross-drive
// path.relative returns an absolute path that does not start with "..", so the old containment check
// treated it as inside the static root. The wildcard static route is outside the token middleware, so
// arbitrary files on another drive (including %3A-encoded forms and mapped network drives) could be
// read without authorization. These tests pin three guards: drive-qualified paths are rejected up
// front, absolute relative results count as outside, and the existing ".." check still holds.

describe("isPathDriveQualified", () => {
  it("detects drive-qualified paths in URL and backslash forms", () => {
    expect(isPathDriveQualified("Z:/marker.txt")).toBe(true);
    expect(isPathDriveQualified("z:\\marker.txt")).toBe(true);
    // A drive-relative path without a separator also switches drives under win32 resolve.
    expect(isPathDriveQualified("Z:marker.txt")).toBe(true);
  });

  it("does not flag ordinary relative paths", () => {
    expect(isPathDriveQualified("assets/app.js")).toBe(false);
    expect(isPathDriveQualified("assets/Z-report.txt")).toBe(false);
    expect(isPathDriveQualified("index.html")).toBe(false);
  });
});

describe("isInsideDirectory", () => {
  it("treats a cross-drive win32 relative result as outside (regression)", () => {
    // Before the fix: path.win32.relative('C:\\zcode\\web', 'Z:\\marker.txt') === 'Z:\\marker.txt',
    // which does not start with ".." and was wrongly accepted as inside the directory.
    expect(isInsideDirectory("C:\\zcode\\web", "Z:\\marker.txt", win32)).toBe(false);
    expect(
      isInsideDirectory("C:\\zcode\\web", win32.resolve("C:\\zcode\\web", "index.html"), win32),
    ).toBe(true);
  });

  it("keeps posix semantics unchanged", () => {
    expect(isInsideDirectory("/srv/web", "/srv/web/assets/app.js", posix)).toBe(true);
    expect(isInsideDirectory("/srv/web", "/srv/web", posix)).toBe(true);
    expect(isInsideDirectory("/srv/web", "/srv/etc/passwd", posix)).toBe(false);
    expect(isInsideDirectory("/srv/web", "/srv/web/../secret", posix)).toBe(false);
  });
});

describe("static route path containment", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveClose, reject) => {
            server.close((error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolveClose();
            });
          }),
      ),
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  async function startStaticServer(): Promise<number> {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-static-"));
    tempDirs.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html>home</html>");
    const server = createHttpServer(new ServiceCollection(), 0, {
      staticRoot,
      spaFallback: true,
    });
    servers.push(server);
    // serve() listens asynchronously; wait for the bound address instead of reading it synchronously.
    return (await listeningAddress(server)).port;
  }

  it("answers 404 for drive-qualified paths, plain or %3A-encoded, without resolving another drive", async () => {
    const port = await startStaticServer();
    expect((await fetch(`http://127.0.0.1:${port}/Z:/marker.txt`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/Z%3A/marker.txt`)).status).toBe(404);
  });

  it("falls back to index.html for encoded ../ after URL normalization instead of escaping the root", async () => {
    const port = await startStaticServer();
    const response = await fetch(`http://127.0.0.1:${port}/%2e%2e/secret.txt`);
    // new URL() folds %2e%2e into .. and normalizes the path, so the route receives the in-root
    // /secret.txt. That file does not exist, so the SPA fallback returns index.html. This shows the
    // response came from the fallback, not from a file outside the root.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>home</html>");
  });
});

import http, { type Server } from "node:http";
import https from "node:https";
import net, { type AddressInfo, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createNodeHttpClientAdapter } from "../src/http/index.js";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";
import { generateTestTlsCertificate } from "./fixtures/tls-localhost.js";

let upstreamIdentity: Awaited<ReturnType<typeof generateTestTlsCertificate>>;
let proxyIdentity: Awaited<ReturnType<typeof generateTestTlsCertificate>>;
beforeAll(async () => {
  [upstreamIdentity, proxyIdentity] = await Promise.all([
    generateTestTlsCertificate(),
    generateTestTlsCertificate(),
  ]);
});

describe.each(["fetch", "HttpClientPort"] as const)("%s explicit TLS CA", (client) => {
  it.each(["direct", "http-proxy", "https-proxy"] as const)(
    "trusts the custom CA through %s and rejects an untrusted certificate",
    async (route) => {
      const directory = await mkdtemp(join(tmpdir(), "zcode-tls-ca-"));
      const caCertFile = join(directory, "ca.pem");
      const unrelatedCaFile = join(directory, "unrelated-ca.pem");
      const upstreamOnlyCaFile = join(directory, "upstream-only-ca.pem");
      const sockets = new Set<Socket>();
      const upstream = https.createServer(upstreamIdentity, (_req, res) => {
        res.end("trusted");
      });
      const proxy =
        route === "https-proxy" ? https.createServer(proxyIdentity) : http.createServer();
      const connectTargets: string[] = [];
      proxy.on("connect", (request, downstream, head) => {
        connectTargets.push(request.url ?? "");
        const target = new URL(`http://${request.url}`);
        const tunnel = net.connect(Number(target.port), target.hostname, () => {
          downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          tunnel.write(head);
          downstream.pipe(tunnel);
          tunnel.pipe(downstream);
        });
        sockets.add(tunnel);
        tunnel.on("error", () => downstream.destroy());
        downstream.on("error", () => tunnel.destroy());
        downstream.on("close", () => tunnel.destroy());
      });
      for (const server of [upstream, proxy]) {
        server.on("connection", (socket) => sockets.add(socket));
      }

      try {
        await writeFile(caCertFile, `${upstreamIdentity.cert}\n${proxyIdentity.cert}`);
        await writeFile(unrelatedCaFile, proxyIdentity.cert);
        await writeFile(upstreamOnlyCaFile, upstreamIdentity.cert);
        const upstreamPort = await listen(upstream);
        const proxyPort = route === "direct" ? undefined : await listen(proxy);
        const proxyUrl = proxyPort
          ? `${route === "https-proxy" ? "https" : "http"}://127.0.0.1:${proxyPort}`
          : undefined;
        const url = `https://127.0.0.1:${upstreamPort}/`;
        const request = async (certPath: string): Promise<string> => {
          if (client === "fetch") {
            const fetch = createNetworkProxyFetch({ caCertFile: certPath, httpProxy: proxyUrl });
            const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
            return response.text();
          }
          const adapter = createNodeHttpClientAdapter({
            caCertFile: certPath,
            proxyUrl,
            timeoutMs: 3_000,
          });
          const response = await adapter.request({ url });
          expect(response.egress?.customCa).toBe(true);
          return new TextDecoder().decode(response.body);
        };

        await expect(request(caCertFile)).resolves.toBe("trusted");
        const successfulConnects = connectTargets.length;
        await expect(request(unrelatedCaFile)).rejects.toThrow(/self[- ]signed certificate/i);
        if (route !== "direct") {
          expect(connectTargets).toHaveLength(successfulConnects + 1);
          expect(connectTargets.at(-1)).toBe(`127.0.0.1:${upstreamPort}`);
        }
        if (route === "https-proxy") {
          const connectsBeforeProxyRejection = connectTargets.length;
          await expect(request(upstreamOnlyCaFile)).rejects.toThrow(/self[- ]signed certificate/i);
          expect(connectTargets).toHaveLength(connectsBeforeProxyRejection);
        }
      } finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all([close(upstream), close(proxy)]);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

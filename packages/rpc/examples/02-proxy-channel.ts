/**
 * Example 2: ProxyChannel — service proxies with no boilerplate.
 *
 * Unlike the hand-written CalculatorChannel in example 1, ProxyChannel exposes a service as a channel
 * in one line and restores it as a service in another.
 *
 * This is how hundreds of services in VS Code communicate across processes so easily.
 */

import {
  Emitter,
  Event,
  DisposableStore,
  ChannelServer,
  ChannelClient,
  ProxyChannel,
  createQueuePair,
} from "../src/index.js";

// ============================================================================
// Define the service interface and implementation.
// ============================================================================

/** File system service interface. */
interface IFileService {
  onDidChangeFile: Event<{ path: string; type: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
}

/** Simulated file system implementation. */
class InMemoryFileService implements IFileService {
  private files = new Map<string, string>();
  private readonly _onDidChangeFile = new Emitter<{ path: string; type: string }>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const isNew = !this.files.has(path);
    this.files.set(path, content);
    this._onDidChangeFile.fire({
      path,
      type: isNew ? "created" : "changed",
    });
  }

  async listFiles(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(dir));
  }
}

// ============================================================================
// Demonstrate ProxyChannel.
// ============================================================================

async function main() {
  const [protocolA, protocolB] = createQueuePair();
  const disposables = new DisposableStore();

  // ========== Server ==========
  const fileService = new InMemoryFileService();

  // One line turns a service into a channel!
  // ProxyChannel.fromService automatically:
  // - Maps readFile, writeFile, and listFiles to call.
  // - Maps onDidChangeFile to listen.
  const channel = ProxyChannel.fromService<string>(fileService, disposables);

  const server = new ChannelServer(protocolB, "server");
  server.registerChannel("fileService", channel);

  // ========== Client ==========
  const client = new ChannelClient(protocolA);
  await Event.toPromise(client.onDidInitialize);

  // One line restores the channel as a type-safe service!
  // Using ES6 Proxy, remoteFS.readFile(...) automatically becomes channel.call('readFile', [...]).
  const remoteFS = ProxyChannel.toService<IFileService>(client.getChannel("fileService"));

  // ========== Use the remote service as if calling local methods! ==========
  console.log("--- ProxyChannel Demo ---");
  console.log("（注意：所有调用都经过了序列化 → 传输 → 反序列化）\n");

  // Listen for file change events.
  const eventDisposable = remoteFS.onDidChangeFile((e) => {
    console.log(`  [file event] ${e.type}: ${e.path}`);
  });

  // Write a file.
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello")');
  await remoteFS.writeFile("/src/util.ts", "export function add(a, b) { return a + b; }");
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello world")'); // 修改

  // Read a file.
  const content = await remoteFS.readFile("/src/main.ts");
  console.log(`\nreadFile('/src/main.ts') = "${content}"`);

  // List files.
  const files = await remoteFS.listFiles("/src");
  console.log(`listFiles('/src') = ${JSON.stringify(files)}`);

  // Test error propagation.
  try {
    await remoteFS.readFile("/nonexistent");
  } catch (err: any) {
    console.log(`readFile('/nonexistent') → Error: ${err.message}`);
  }

  // Clean up.
  eventDisposable.dispose();
  client.dispose();
  server.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);

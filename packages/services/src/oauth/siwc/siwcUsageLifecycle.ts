import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import { buildSiwcAccountCredentialKeys } from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { buildSiwcCodexRefreshLockFileName } from "./siwcCodexWire.js";

/** Tombstones survive sign-out so a delayed grant cannot revive a later login of the same account. */
export class SiwcUsageLifecycle {
  constructor(
    private readonly credentials: ICredentialService,
    private readonly configDir: string,
  ) {}
  withLock<T>(account: string, operation: () => Promise<T>): Promise<T> {
    return withFileLock(
      join(this.configDir, buildSiwcCodexRefreshLockFileName(account)),
      operation,
      { lockMaxWaitMs: 45_000 },
    );
  }
  readEpoch(account: string) {
    return this.credentials.load(`fork:oauth:chatgpt:${account}:usage-epoch`);
  }
  async invalidate(account: string): Promise<string> {
    const epoch = randomUUID();
    await this.credentials.save(`fork:oauth:chatgpt:${account}:usage-epoch`, epoch);
    return epoch;
  }
  async isCurrent(account: string, epoch: string | null): Promise<boolean> {
    return (
      (await this.readEpoch(account)) === epoch &&
      Boolean(await this.credentials.load(buildSiwcAccountCredentialKeys(account).accessToken))
    );
  }
}

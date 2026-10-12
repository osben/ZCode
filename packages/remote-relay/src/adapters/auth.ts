import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RelayCrypto } from "../contract.js";

export const relayCrypto: RelayCrypto = {
  randomId: randomUUID,
  verify: (key, nonce, role, sid, proof) => {
    const expected = createHmac("sha256", key)
      .update(`${nonce}|${role}|${sid}`)
      .digest("base64url");
    const candidate = Buffer.from(proof, "utf8");
    const actual = Buffer.from(expected, "utf8");
    return candidate.length === actual.length && timingSafeEqual(candidate, actual);
  },
};

import { isIP } from "node:net";

/**
 * Key for the anonymous per-source limiter. IPv6 addresses collapse to their /64 prefix, so an attacker who
 * owns a /64 cannot get a fresh bucket per address. IPv4 and unparsable values are returned unchanged.
 */
export function limiterKey(address: string): string {
  const bare = address.split("%")[0] ?? address;
  if (isIP(bare) !== 6) return address;
  const [head = "", tail] = bare.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  // An embedded IPv4 tail (::ffff:1.2.3.4 style) counts as two groups.
  const groups = [
    ...front,
    ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"),
    ...back,
  ];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group || "0", 16).toString(16))
    .join(":")}::/64`;
}

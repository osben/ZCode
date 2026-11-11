import { seedOfficialPluginsForForkRustAgent } from "./contract.js";

/** The storage Worker seeds after the database step; a Node-mode env leaves the store alone. */
export function exampleSeedOfficialPluginsForForkRustAgent() {
  seedOfficialPluginsForForkRustAgent({ cwd: process.cwd(), env: process.env });
}

import { FORK_NODE_HELPER_COMMAND_ENV, FORK_RUST_HELPER_SUBCOMMAND } from "./contract.js";

/** The env entry the Host gives the Rust agent: the bundled entry run as Node with the helper subcommand. */
export const exampleHelperEnv = {
  [FORK_NODE_HELPER_COMMAND_ENV]: JSON.stringify({
    command: "/Applications/Example.app/Contents/MacOS/Example",
    args: [
      "/Applications/Example.app/Contents/Resources/zcode.cjs",
      FORK_RUST_HELPER_SUBCOMMAND,
      "--stdio",
    ],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  }),
};

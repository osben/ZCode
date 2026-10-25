export interface HttpEntryEnv {
  readonly port: number;
  readonly host?: string;
  readonly staticRoot?: string;
  readonly authToken?: string;
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** Map process env to HTTP entry options; ZCODE_SERVER_HOST takes precedence over HOST. */
export function readHttpEntryEnv(env: NodeJS.ProcessEnv): HttpEntryEnv {
  const host = readTrimmed(env, "ZCODE_SERVER_HOST") ?? readTrimmed(env, "HOST");
  const staticRoot = readTrimmed(env, "ZCODE_WEB_STATIC_ROOT");
  const authToken = readTrimmed(env, "ZCODE_SERVER_AUTH_TOKEN");
  return {
    port: Number(env["PORT"]) || 3030,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot } : {}),
    ...(authToken ? { authToken } : {}),
  };
}

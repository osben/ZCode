// 由各 bundler 通过 define 注入，避免运行时 JSON import 的跨 bundler 兼容问题。
// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，
// 用 typeof 检查 + fallback 避免 ReferenceError。
declare const __ZCODE_VERSION__: string;
declare const __ZCODE_COMMIT__: string;
declare const __ZCODE_BUILD_TIME__: string;

export const ZCODE_VERSION: string =
  typeof __ZCODE_VERSION__ !== "undefined" ? __ZCODE_VERSION__ : "0.0.0-dev";
export const ZCODE_COMMIT: string =
  typeof __ZCODE_COMMIT__ !== "undefined" ? __ZCODE_COMMIT__ : "unknown";
export const ZCODE_BUILD_TIME: string =
  typeof __ZCODE_BUILD_TIME__ !== "undefined" ? __ZCODE_BUILD_TIME__ : "unknown";

// fork 版本形如 3.15.1-fork.2：本地展示与远端资产身份用完整版本，
// 但 z.ai 后端按 semver 门控行为（如 OAuth 网站按 app_version 决定 deep link），
// -fork.N 后缀会被判为低于同基线正式版。发往后端的版本字符串只保留上游基线；
// 其他 prerelease（如 dev 兜底版本）不属于 fork 标记，保持原样。
export function stripZcodeForkVersionSuffix(version: string): string {
  const match = /^(\d+\.\d+\.\d+)-fork\.\d+$/.exec(version.trim());
  return match ? match[1]! : version;
}

export const ZCODE_UPSTREAM_BASE_VERSION: string = stripZcodeForkVersionSuffix(ZCODE_VERSION);

export function resolveForkBase(version) {
  if (typeof version !== "string") {
    return null;
  }

  // 不能先去空格：调用方还会用原始版本解析 fork 序号，校验与解析必须使用同一字符串。
  const normalizedVersion = version;
  if (!/^\d+\.\d+\.\d+(?:-fork\.\d+)?$/.test(normalizedVersion)) {
    return null;
  }

  const match = /^(\d+\.\d+\.\d+)-fork\.\d+$/.exec(normalizedVersion);
  return {
    base: match ? match[1] : normalizedVersion,
    isForkVersion: Boolean(match),
  };
}

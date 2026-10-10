/** Troubleshooting material for user feedback only; must not be applied to model requests or authentication payloads. */
const REDACTED = "[REDACTED]";
const sensitiveKey =
  /(?:password|passwd|passphrase|secret|token|apikey|accesskey|privatekey|authorization|cookie|credential)/i;
const diagnosticBodyKey =
  /^(?:content|messages?|prompt|systemprompt|request|response|body|payload|input|output|toolinput|tooloutput|arguments|args|env|environment|headers|text|completion|result|stdout|stderr|data|params)$/i;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "");
}

function shouldRedactKey(key: string, diagnostic: boolean): boolean {
  const normalized = normalizeKey(key);
  return sensitiveKey.test(normalized) || (diagnostic && diagnosticBodyKey.test(normalized));
}

// Share key-name checks with JSON objects; quoted, escaped, or delimited fields must not use a separate, smaller list.
function fieldKeys(text: string): Array<{ key: string; quoted: boolean; end: number }> {
  const fields = [];
  const pattern = /(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([\w.-]+))\s*[:=]\s*/g;
  for (const match of text.matchAll(pattern)) {
    let key = match[1] ?? match[2] ?? match[3] ?? "";
    if (match[1] !== undefined) {
      try {
        key = JSON.parse(`"${key}"`) as string;
      } catch {
        // Check the literal key name even when decoding fails.
      }
    }
    fields.push({ key, quoted: match[3] === undefined, end: match.index + match[0].length });
  }
  return fields;
}

function shouldRedactUrlPath(url: URL, diagnostic: boolean): boolean {
  if (diagnostic || url.username || url.password || url.hostname === "hooks.slack.com") return true;
  // The object path in a signed download URL may also be a credential; classify it before removing the query.
  if (
    [...url.searchParams.keys()].some(
      (key) => shouldRedactKey(key, false) || /^(?:.*signature|sig|code)$/i.test(normalizeKey(key)),
    )
  )
    return true;
  try {
    return decodeURIComponent(url.pathname)
      .split("/")
      .some((segment) => {
        const normalized = normalizeKey(segment);
        return (
          sensitiveKey.test(normalized) ||
          /^(?:webhook\w*|(?:password)?reset(?:password)?|invites?|invitations?|callback|downloads?|signed|verify|verification|activate|magiclink)$/.test(
            normalized.toLowerCase(),
          )
        );
      });
  } catch {
    // An undecodable path cannot be proven safe; this prevents encoded forms from bypassing detection.
    return true;
  }
}

function redactValues(text: string, diagnostic: boolean): string {
  let result = text
    .replace(/\b((?:Proxy-)?Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`)
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
      REDACTED,
    )
    .replace(/\bBearer\s+[^\s"'\\,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /([\w.-]+)(\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;"'<>]+)/g,
      (match, key: string, separator: string) =>
        shouldRedactKey(key, false) ? `${key}${separator}${REDACTED}` : match,
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        // URL credentials are not limited to userinfo/query; webhooks and reset links often put secrets in the path.
        if (shouldRedactUrlPath(url, diagnostic) && url.pathname && url.pathname !== "/") {
          url.pathname = `/${REDACTED}`;
        }
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return REDACTED;
      }
    })
    .replace(/(?:\/(?:Users|home)\/|[a-z]:\\Users\\)[^\s"'<>]+/gi, "[USER_PATH]");
  if (diagnostic) {
    result = result.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]");
  }
  return result;
}

function scrubValue(value: unknown, diagnostic: boolean, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (typeof value === "string") {
    // Strings may contain log prefixes or multiple JSON fragments, so they must use the same complete redaction path.
    return redactText(value, diagnostic, depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, diagnostic, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shouldRedactKey(key, diagnostic) ? REDACTED : scrubValue(item, diagnostic, depth + 1),
      ]),
    );
  }
  return value;
}

function redactPlainText(text: string, diagnostic: boolean): string {
  return redactValues(text, diagnostic)
    .split(/\r?\n/)
    .map((line) => {
      // Length and line boundaries in unstructured text are unreliable; discard the line if a known sensitive field cannot be parsed safely.
      const unsafe = fieldKeys(line).some(
        ({ key, quoted, end }) =>
          shouldRedactKey(key, diagnostic) &&
          (quoted || diagnostic || !line.slice(end).startsWith(REDACTED)),
      );
      return unsafe ? REDACTED : line;
    })
    .join("\n");
}

function jsonFragmentEnd(text: string, start: number): number {
  let nesting = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") nesting += 1;
    else if ((character === "}" || character === "]") && --nesting === 0) return index + 1;
  }
  return text.length;
}

function redactText(text: string, diagnostic: boolean, depth: number): string {
  if (depth > 32) return REDACTED;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(scrubValue(parsed, diagnostic, depth + 1));
    }
  } catch {
    // Continue processing mixed logs fragment by fragment; do not sanitize only the final parseable JSON object.
  }
  // Private keys and ordinary credentials may span lines or contain brackets; sanitize the whole value first to avoid leaving a suffix after fragment splitting.
  const source = redactValues(text, diagnostic);
  const chunks: string[] = [];
  let cursor = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith(REDACTED, index)) {
      index += REDACTED.length - 1;
      continue;
    }
    if (source[index] !== "{" && source[index] !== "[") continue;
    const prefix = source.slice(cursor, index);
    let end = jsonFragmentEnd(source, index);
    const linePrefix = prefix.slice(prefix.lastIndexOf("\n") + 1);
    const sensitiveValue = fieldKeys(linePrefix).some(({ key }) =>
      shouldRedactKey(key, diagnostic),
    );
    if (sensitiveValue) {
      // An ordinary field value may mix text and objects; do not remove only the object and leave the trailing text on the same line.
      const lineEnd = source.indexOf("\n", end);
      end = lineEnd < 0 ? source.length : lineEnd;
    }
    const fragment = source.slice(index, end);
    chunks.push(redactPlainText(prefix, diagnostic));
    try {
      chunks.push(
        sensitiveValue
          ? REDACTED
          : JSON.stringify(scrubValue(JSON.parse(fragment), diagnostic, depth + 1)),
      );
    } catch {
      // For multiline or truncated objects, dropping only the line with the key could still expose the value on the next line.
      chunks.push(
        sensitiveValue || fieldKeys(fragment).some(({ key }) => shouldRedactKey(key, diagnostic))
          ? REDACTED
          : redactPlainText(fragment, diagnostic),
      );
    }
    cursor = end;
    index = end - 1;
  }
  chunks.push(redactPlainText(source.slice(cursor), diagnostic));
  return chunks.join("");
}

export function redactFeedbackText(text: string, options: { diagnostic?: boolean } = {}): string {
  return redactText(text, options.diagnostic === true, 0);
}

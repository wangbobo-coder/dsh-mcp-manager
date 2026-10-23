/**
 * Canonical MCP server model plus the dialect machinery every adapter shares.
 *
 * The fifteen-ish clients in the wild disagree on almost everything: the
 * container key, whether `type` exists, five spellings for streamable HTTP,
 * `env` vs `environment`, `command` as string vs array, three timeout units.
 * None of that leaks upward: adapters decode into this model and encode back,
 * preserving fields they do not understand so a rewrite never loses a user's
 * client-specific option.
 *
 * Canonical transport is three values. Clients that key off the URL rather than
 * a type tag still round-trip correctly because the decoder reads the shape.
 */

export const TRANSPORTS = Object.freeze(['stdio', 'http-stream', 'http-sse']);

/** Fields the canonical model owns; everything else rides in `extra`. */
const OWNED = new Set([
  'type', 'command', 'args', 'env', 'environment', 'cwd',
  'url', 'serverUrl', 'httpUrl', 'headers', 'disabled', 'enabled',
  'timeout', 'timeoutMs', 'toolCallTimeoutMs',
  'autoApprove', 'alwaysAllow',
]);

/* ------------------------------------------------------------- secrets ---- */

const SECRET_KEY = /(token|key|secret|password|passwd|credential|auth|cookie|session|private)/i;

/** True when an env/header key name looks like it carries a credential. */
export function isSecretKey(key) {
  return typeof key === 'string' && SECRET_KEY.test(key);
}

/**
 * True when a value is an indirection rather than the credential itself —
 * `${VAR}`, `{{x}}`, `{env:X}`, `%VAR%`, `<placeholder>`. These are safe to show
 * because they name a secret instead of carrying one.
 */
export function isReferenceValue(value) {
  return typeof value === 'string' && /^\$\{|\{\{|\$env:|^\{env:|^%[A-Za-z_]+%$|^<.*>$/.test(value);
}

/**
 * A literal value shaped like a real credential (long, opaque).
 *
 * Only used to *rank* findings — never to decide whether to mask. Masking is
 * key-driven, because a short secret (`ZZ_TOKEN: abc`) is still a secret and a
 * heuristic that inspects values would happily print it.
 */
export function isSecretValue(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 12) return false;
  if (isReferenceValue(value)) return false;
  return /[A-Za-z0-9_\-]{16,}/.test(value) || value.length >= 24;
}

export function maskValue(value) {
  const text = String(value ?? '');
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

/**
 * Is this string a placeholder produced by `maskValue`?
 *
 * A masked copy must never be written back to a config file: it would replace a
 * real credential with bullets and silently break the server. Write paths use
 * this to refuse, and to explain why.
 */
export function isMaskedValue(value) {
  return typeof value === 'string' && value.includes('••••');
}

/* ---------------------------------------------------------- normalization -- */

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function pickTimeout(entry) {
  if (typeof entry.timeoutMs === 'number') return entry.timeoutMs;
  if (typeof entry.toolCallTimeoutMs === 'number') return entry.toolCallTimeoutMs;
  if (typeof entry.timeout === 'number') {
    // `timeout` is milliseconds in Gemini/Qwen, seconds in Roo/Codex.
    return entry.timeout * (entry.__timeoutUnit === 's' ? 1000 : 1);
  }
  return undefined;
}

/**
 * Decode one raw client entry into the canonical model.
 *
 * `dialect` carries what the client means by ambiguous fields:
 *   { urlKey, typeMap, envKey, commandArray, timeoutUnit }
 */
export function decodeEntry(name, entry, dialect = {}) {
  const raw = asObject(entry);
  const urlKey = dialect.urlKey ?? 'url';
  const envKey = dialect.envKey ?? 'env';
  const typeMap = dialect.typeMap ?? {};
  const declaredType = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  const mapped = typeMap[declaredType] ?? null;

  const url = raw[urlKey] ?? raw.url ?? raw.httpUrl ?? raw.serverUrl;
  let transport = 'stdio';
  if (mapped) transport = mapped;
  else if (typeof url === 'string' && url) {
    // No usable type tag: infer. `sse` hint wins, otherwise streamable HTTP.
    const hint = (declaredType || String(raw.__sseHint ?? '')).toLowerCase();
    transport = hint === 'sse' ? 'http-sse' : 'http-stream';
  } else if (declaredType === 'sse') transport = 'http-sse';
  else if (declaredType && ['http', 'streamable-http', 'streamablehttp', 'remote'].includes(declaredType)) transport = 'http-stream';
  else if (['local', 'stdio'].includes(declaredType)) transport = 'stdio';
  else if (raw.command !== undefined) transport = 'stdio';

  const commandValue = raw.command;
  const commandArray = Array.isArray(commandValue);
  const commandParts = commandArray ? asStringArray(commandValue) : [String(commandValue ?? '')];
  const command = commandParts[0] ?? '';
  const args = commandArray ? commandParts.slice(1) : asStringArray(raw.args);

  const env = {};
  const headers = {};
  for (const [key, value] of Object.entries(asObject(raw[envKey]))) env[key] = value;
  for (const [key, value] of Object.entries(asObject(raw.headers))) headers[key] = value;

  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (OWNED.has(key)) continue;
    if (key === urlKey) continue;
    extra[key] = value;
  }

  const enabled = raw.disabled === true ? false : raw.enabled === false ? false : true;
  const autoApproveRaw = raw.autoApprove ?? raw.alwaysAllow;
  const autoApprove = autoApproveRaw === true ? true : Array.isArray(autoApproveRaw) ? autoApproveRaw.map(String) : [];

  /*
   * Any credential-named field holding a literal is a finding; `literal`
   * separates an opaque-looking value from a short one so the UI can rank them
   * without either being hidden.
   */
  const secrets = [];
  for (const [key, value] of Object.entries(env)) {
    if (isSecretKey(key) && !isReferenceValue(value) && String(value ?? '').length > 0) secrets.push({ where: 'env', key, literal: isSecretValue(value) });
  }
  for (const [key, value] of Object.entries(headers)) {
    if (isSecretKey(key) && !isReferenceValue(value) && String(value ?? '').length > 0) secrets.push({ where: 'header', key, literal: isSecretValue(value) });
  }
  for (const found of secretArgs(args)) {
    if (!isReferenceValue(String(found.value))) secrets.push({ where: 'args', key: found.key, literal: isSecretValue(String(found.value)) });
  }

  return {
    name,
    transport,
    command,
    args,
    env,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    url: typeof url === 'string' ? url : undefined,
    headers,
    timeoutMs: pickTimeout({ ...raw, __timeoutUnit: dialect.timeoutUnit }),
    enabled,
    autoApprove,
    extra,
    secrets,
    declaredType: raw.type,
    raw,
  };
}

/**
 * Encode the canonical model back into one client's entry shape, using the
 * dialect's own spellings and units. Unknown fields in `extra` survive.
 */
export function encodeEntry(server, dialect = {}, previous = undefined) {
  const urlKey = dialect.urlKey ?? 'url';
  const envKey = dialect.envKey ?? 'env';
  const typeMap = dialect.typeMap ?? {};
  const reverse = dialect.reverseType ?? {};
  const out = { ...asObject(server.extra) };

  if (server.transport === 'stdio') {
    const parts = [server.command, ...(server.args ?? [])].filter((part) => part !== undefined && part !== '');
    if (dialect.commandArray) out.command = parts;
    else {
      out.command = server.command ?? '';
      if (server.args && server.args.length) out.args = [...server.args];
      else delete out.args;
    }
    if (Object.keys(server.env ?? {}).length) out[envKey] = { ...server.env };
    else delete out[envKey];
    if (server.cwd) out.cwd = server.cwd;
    else delete out.cwd;
    delete out[urlKey];
    if (urlKey !== 'url') delete out.url;
    delete out.headers;
  } else {
    out[urlKey] = server.url ?? '';
    if (Object.keys(server.headers ?? {}).length) out.headers = { ...server.headers };
    else delete out.headers;
    delete out.command;
    delete out.args;
    delete out[envKey];
    if (envKey !== 'env') delete out.env;
    delete out.cwd;
  }

  // `type`: only written where the client interprets it, with its own spelling.
  const typeValue = reverse[server.transport];
  if (typeValue !== undefined && typeValue !== null) out.type = typeValue;
  else if (dialect.typeRequired) out.type = server.transport === 'stdio' ? (dialect.stdioType ?? 'stdio') : (typeMap.http ?? 'http');
  else if (dialect.dropUnknownType) delete out.type;
  else if (typeof server.declaredType === 'string' && !reverse[server.transport]) out.type = server.declaredType;
  else delete out.type;

  // Timeout in the client's own unit.
  delete out.timeoutMs;
  delete out.toolCallTimeoutMs;
  if (typeof server.timeoutMs === 'number' && server.timeoutMs > 0) {
    if (dialect.timeoutField) out[dialect.timeoutField] = dialect.timeoutUnit === 's' ? Math.round(server.timeoutMs / 1000) : server.timeoutMs;
    else delete out.timeout;
  } else {
    delete out.timeout;
  }

  if (server.enabled === false) {
    if (dialect.enabledField === 'enabled') out.enabled = false;
    else out.disabled = true;
  } else {
    if (dialect.enabledField === 'enabled') { if (out.enabled === false) out.enabled = true; }
    else delete out.disabled;
  }

  const autoField = dialect.autoApproveField;
  if (autoField) {
    const value = server.autoApprove;
    if (value === true) out[autoField] = true;
    else if (Array.isArray(value) && value.length) out[autoField] = [...value];
    else delete out[autoField];
  }

  // Keep undefined out of the serialized form.
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

/* --------------------------------------------------------------- plumbing -- */

const NAME_SAFE = /[^A-Za-z0-9_-]+/g;

/** Sanitize an external server name into `[A-Za-z0-9_-]{1,32}`. */
export function sanitizeName(raw, fallback = 'server') {
  const cleaned = String(raw ?? '').trim().replace(NAME_SAFE, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return cleaned || fallback;
}

/**
 * The `serverName` to mount a server under inside DeepSeek Harness.
 *
 * The harness's own `@deepseek-ai/dsh-mcp-client` constrains `serverName` to
 * `/^[A-Za-z0-9_-]{1,32}$/` (lib/index.js of that package, the zod schema and
 * `SERVER_NAME_PATTERN`), so a name like `示例服务器 - API 文档` CANNOT be used
 * verbatim. It has to be mapped.
 *
 * `sanitizeName` alone is not a usable mapping here: every CJK name collapses
 * to whatever ASCII fragments it contains — `示例服务器 - API 文档`,
 * `示例助手 - API 文档` and `另一个服务 - API 文档` ALL become `API`, and
 * for a fully-CJK name it falls back to the constant `server`. That collision is
 * not cosmetic. It produced two visible bugs: the mount row was created under
 * `API`, the page looked the mount up by the display name (found nothing), so
 * the switch showed "off" for a mounted server — and `waitForRow` waited for a
 * row named after the display name, never saw it, and told the user to restart.
 *
 * So there are two shapes, both pure functions of the display name:
 *
 *   1. An all-ASCII name keeps `sanitizeName`'s result unchanged. Those names
 *      are already readable and already distinct from each other, so
 *      `My Bridge` stays `My-Bridge` and `my server!` stays
 *      `my-server` — which also means rows mounted before this mapping existed
 *      keep their identity.
 *   2. A name with any non-ASCII character — CJK, full-width punctuation,
 *      emoji — is exactly the case that collapses under `sanitizeName`, so it
 *      gets a short deterministic suffix derived from the ORIGINAL name.
 *      `fingerprint` is the FNV-1a helper in this module, so the same display
 *      name always yields the same mount name (a repeat apply updates the row
 *      instead of accumulating one per click) while two different CJK names
 *      cannot collide.
 */
export function dshMountName(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return 'server';
  if (/^[A-Za-z0-9_-]{1,32}$/.test(original)) return original;
  const base = sanitizeName(original, '');
  if (/^[\x20-\x7E]+$/.test(original) && base) return base;
  return `${(base || 'mcp').slice(0, 22)}-${fingerprint(original).slice(0, 8)}`;
}

/** Return `name`, or `name-2`/`name-3`… when taken. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name.slice(0, 28)}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot derive a unique name for ${name}`);
}

/** Deterministic short fingerprint for change detection. */
export function fingerprint(value) {
  const text = stableStringify(value ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** JSON with object keys sorted, so equal objects always hash equally. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The fields that define a server, exactly as `sameDefinition` compares them.
 * One normalizer for both hashing and equality keeps the ledger, the scan and
 * the write guard from disagreeing about what "the same entry" means.
 */
function definitionShape(server) {
  return {
    transport: server?.transport ?? 'stdio',
    command: server?.command ?? null,
    args: server?.args ?? [],
    env: server?.env ?? {},
    cwd: server?.cwd ?? null,
    url: server?.url ?? null,
    headers: server?.headers ?? {},
    timeoutMs: server?.timeoutMs ?? null,
    autoApprove: server?.autoApprove ?? [],
    enabled: server?.enabled !== false,
    extra: server?.extra ?? {},
  };
}

/** Same definition, semantically. */
export function sameDefinition(left, right) {
  return stableStringify(definitionShape(left)) === stableStringify(definitionShape(right));
}

/** Stable identity of a definition, for the ownership ledger and drift checks. */
export function definitionHash(server) {
  return fingerprint(definitionShape(server));
}

/**
 * Compare two canonical servers field by field, so the UI can show what a sync
 * would actually change instead of a bare "differs".
 */
export function diffServers(left, right) {
  const fields = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'timeoutMs', 'enabled'];
  const changed = [];
  for (const field of fields) {
    const a = JSON.stringify(left?.[field] ?? null);
    const b = JSON.stringify(right?.[field] ?? null);
    if (a !== b) changed.push({ field, from: left?.[field] ?? null, to: right?.[field] ?? null });
  }
  return changed;
}

/**
 * Match an argument that carries a credential, in either of the two shapes
 * CLIs accept:
 *
 *   --figma-api-key=figd_xxx        (inline value)
 *   --api-key figd_xxx              (separate value — the *next* argument)
 *
 * The command line is a first-class place for secrets: `npx figma-developer-mcp
 * --figma-api-key=…` is the documented invocation, so masking env and headers
 * alone leaves real tokens in the payload.
 */
const SECRET_ARG_INLINE = /^(--?[A-Za-z0-9_.-]*(?:token|key|secret|password|passwd|credential|auth|cookie|session|private)[A-Za-z0-9_.-]*)=(.*)$/i;
const SECRET_ARG_FLAG = /^--?[A-Za-z0-9_.-]*(?:token|key|secret|password|passwd|credential|auth|cookie|session|private)[A-Za-z0-9_.-]*$/i;

/** Find credential-bearing arguments; returns [{index, key, value}] for masking. */
export function secretArgs(args) {
  const out = [];
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const text = String(list[index] ?? '');
    const inline = text.match(SECRET_ARG_INLINE);
    if (inline) { out.push({ index, key: inline[1], value: inline[2] }); continue; }
    if (SECRET_ARG_FLAG.test(text)) {
      const next = list[index + 1];
      if (typeof next === 'string' && next && !next.startsWith('-')) out.push({ index: index + 1, key: text, value: next });
    }
  }
  return out;
}

/** Mask every credential-bearing argument, leaving the flag visible. */
export function redactArgs(args) {
  const list = Array.isArray(args) ? [...args] : [];
  for (const found of secretArgs(list)) {
    const token = String(found.value ?? '');
    if (!token || isReferenceValue(token)) continue;
    const masked = maskValue(token);
    const current = String(list[found.index] ?? '');
    /*
     * When the secret shared an argument with its flag, keep the flag: mask the
     * value portion only, otherwise the argument no longer reads as a flag.
     */
    list[found.index] = current.startsWith(`${found.key}=`) ? `${found.key}=${masked}` : masked;
  }
  return list;
}

/**
 * Strip credential literals before a server object crosses to the browser.
 *
 * Redaction covers every place a literal can hide, not just the two maps the
 * canonical model owns: `args` is the documented home of `--api-key=…` flags,
 * `raw` holds a full copy of the original entry, and `extra` holds unmodelled
 * client options, so a token in an unusual key would otherwise ride along
 * inside the scan payload and into the model's context. Masking is
 * depth-limited and cycle-safe because `raw` is client JSON, which has been
 * known to nest arbitrarily.
 */
export function redactServer(server, reveal = false) {
  if (reveal || !server) return server;

  const seen = new WeakSet();
  const scrub = (value, keyHint, depth) => {
    if (depth > 8) return '…';
    if (typeof value === 'string') {
      /*
       * Key-driven masking: a credential-named field is masked whatever its
       * length, except when the value is an indirection that only names the
       * secret. Masking on value shape alone would leak short tokens.
       */
      return keyHint && isSecretKey(keyHint) && !isReferenceValue(value) ? maskValue(value) : value;
    }
    if (Array.isArray(value)) {
      /*
       * A nested argument list obeys the same flag rule as the top-level one;
       * `raw` carries the client's own copy of `args`, so masking only the
       * modelled field would still ship the literal inside it.
       */
      if (keyHint === 'args') return redactArgs(value);
      return value.map((item) => scrub(item, keyHint, depth + 1));
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      const out = {};
      for (const [key, inner] of Object.entries(value)) out[key] = scrub(inner, key, depth + 1);
      seen.delete(value);
      return out;
    }
    return value;
  };

  const out = {};
  for (const [key, value] of Object.entries(server)) {
    if (key === 'env' || key === 'headers' || key === 'extra' || key === 'raw') {
      out[key] = scrub(value, null, 0);
      continue;
    }
    if (key === 'args') {
      out[key] = redactArgs(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Byte-preserving editors for the config formats MCP clients actually ship.
 *
 * Every client file is shared property: it holds the user's other settings,
 * comments, key order, and formatting. A full parse/serialize round trip
 * destroys all of that (and `.claude.json` is a multi-megabyte mixed file),
 * so each writer here computes text splices over the original string and
 * touches only the bytes belonging to the container it owns.
 *
 * Formats:
 *   - JSON / JSONC  `{ "mcpServers": { ... } }`   (strict, comments tolerated)
 *   - TOML          `[mcp_servers.<id>]`           (Codex CLI)
 *   - YAML          `mcpServers:` list of mappings (Continue) — read only
 */

const TRIVIA = new Set([' ', '\t', '\r', '\n']);

/** Skip whitespace, `//` line comments, and block comments. */
function skipTrivia(text, pos) {
  let i = pos;
  for (;;) {
    while (i < text.length && TRIVIA.has(text[i])) i += 1;
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    return i;
  }
}

function scanString(text, pos) {
  let i = pos + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') return i + 1;
    i += 1;
  }
  throw new Error(`unterminated string at ${pos}`);
}

/**
 * Scan one JSON value into a node tree carrying byte offsets for every key and
 * value. Offsets are what make surgical splicing possible.
 */
function scanValue(text, pos) {
  const start = pos;
  const ch = text[pos];
  if (ch === '{') {
    const pairs = [];
    let i = skipTrivia(text, pos + 1);
    if (text[i] === '}') return { type: 'object', start, end: i + 1, pairs };
    for (;;) {
      i = skipTrivia(text, i);
      if (text[i] !== '"') throw new Error(`expected key at ${i}`);
      const keyStart = i;
      const keyEnd = scanString(text, i);
      const key = JSON.parse(text.slice(keyStart, keyEnd));
      i = skipTrivia(text, keyEnd);
      if (text[i] !== ':') throw new Error(`expected ':' at ${i}`);
      i = skipTrivia(text, i + 1);
      const value = scanValue(text, i);
      i = skipTrivia(text, value.end);
      const pair = { key, keyStart, keyEnd, pairStart: keyStart, value };
      if (text[i] === ',') {
        pair.commaEnd = i + 1;
        pairs.push(pair);
        i = skipTrivia(text, i + 1);
        if (text[i] === '}') return { type: 'object', start, end: i + 1, pairs };
        continue;
      }
      pairs.push(pair);
      if (text[i] === '}') return { type: 'object', start, end: i + 1, pairs };
      throw new Error(`expected ',' or '}' at ${i}`);
    }
  }
  if (ch === '[') {
    const items = [];
    let i = skipTrivia(text, pos + 1);
    if (text[i] === ']') return { type: 'array', start, end: i + 1, items };
    for (;;) {
      i = skipTrivia(text, i);
      if (text[i] === ']') return { type: 'array', start, end: i + 1, items };
      if (text[i] === undefined) throw new Error('unterminated array');
      const item = scanValue(text, i);
      items.push(item);
      i = skipTrivia(text, item.end);
      if (text[i] === ',') { i = skipTrivia(text, i + 1); continue; }
      if (text[i] === ']') return { type: 'array', start, end: i + 1, items };
      // tolerate a missing comma between items: the next iteration re-reads
      continue;
    }
  }
  if (ch === '"') return { type: 'string', start, end: scanString(text, pos) };
  let i = pos;
  while (i < text.length && !',}] \t\r\n'.includes(text[i])) i += 1;
  if (i === pos) throw new Error(`unexpected '${ch}' at ${pos}`);
  return { type: 'scalar', start, end: i };
}

function keyStartOf(text, keyEnd) {
  // Walk back from end of the key string to its opening quote.
  let i = keyEnd - 1;
  while (i > 0) {
    if (text[i] === '"' && text[i - 1] !== '\\') return i;
    i -= 1;
  }
  return 0;
}

/** Parse JSON/JSONC text leniently; returns `{ value, tree, text }`. */
export function parseJsonc(text) {
  const source = typeof text === 'string' ? text : '';
  const start = skipTrivia(source, 0);
  if (start >= source.length) return { value: {}, tree: null, text: source };
  const tree = scanValue(source, start);
  const value = strictJson(source.slice(tree.start, tree.end));
  return { value, tree, text: source };
}

/** JSON.parse that tolerates comments and trailing commas. */
export function strictJson(chunk) {
  const cleaned = stripComments(chunk).replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned);
}

function stripComments(chunk) {
  let out = '';
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    if (ch === '"') {
      const end = scanString(chunk, i);
      out += chunk.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && chunk[i + 1] === '/') {
      while (i < chunk.length && chunk[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && chunk[i + 1] === '*') {
      const end = chunk.indexOf('*/', i + 2);
      i = end < 0 ? chunk.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function findNode(tree, path) {
  let node = tree;
  for (const key of path) {
    if (!node || node.type !== 'object') return null;
    const pair = node.pairs.find((item) => item.key === key);
    if (!pair) return null;
    node = pair.value;
  }
  return node;
}

function detectIndentUnit(text) {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return '  ';
  return match[1].includes('\t') ? match[1] : match[1].length >= 4 ? match[1].slice(0, 4) : match[1] || '  ';
}

function indentOfLine(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : '';
}

function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of sorted) {
    // Guard against overlapping splices: skip any edit fully inside a later one.
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function renderJson(value, indentUnit, depth) {
  const pad = indentUnit.repeat(depth);
  const childPad = indentUnit.repeat(depth + 1);
  const js = JSON.stringify(value, null, indentUnit);
  if (js === undefined) return 'null';
  return js.replace(/\n/g, `\n${pad}`).split('\n').slice(0, 1).join('') === ''
    ? js
    : js;
}

function insertionFor(text, containerNode, key, value) {
  const unit = detectIndentUnit(text);
  const pairs = containerNode.pairs;
  const serialized = JSON.stringify(value, null, unit);
  if (pairs.length === 0) {
    const pad = `${indentOfLine(text, containerNode.start)}${unit}`;
    const body = `${serialized}`.replace(/\n/g, `\n${pad}`);
    return { start: containerNode.start + 1, end: containerNode.start + 1, text: `\n${pad}"${key}": ${body}\n${indentOfLine(text, containerNode.start)}` };
  }
  const last = pairs[pairs.length - 1];
  const pad = `${indentOfLine(text, last.pairStart)}`;
  const body = `${serialized}`.replace(/\n/g, `\n${pad}`);
  return { start: last.value.end, end: last.value.end, text: `,\n${pad}"${key}": ${body}` };
}

function removalFor(text, containerNode, pair) {
  const pairs = containerNode.pairs;
  const index = pairs.indexOf(pair);
  if (index > 0) {
    const previous = pairs[index - 1];
    return { start: previous.value.end, end: pair.value.end, text: '' };
  }
  if (pairs.length > 1) {
    const next = pairs[1];
    return { start: pair.pairStart, end: next.pairStart, text: '' };
  }
  return { start: pair.pairStart, end: pair.value.end, text: '' };
}

/**
 * Read the named container object (e.g. `mcpServers`) as a plain value plus the
 * node needed to splice it. Missing container yields an empty object.
 */
export function readContainer(text, containerPath) {
  const source = typeof text === 'string' ? text : '';
  let parsed;
  try {
    parsed = parseJsonc(source);
  } catch (error) {
    return { ok: false, error: `parse error: ${error.message}`, value: {} };
  }
  const node = parsed.tree ? findNode(parsed.tree, [containerPath]) : null;
  const value = node && node.type === 'object' ? strictJson(source.slice(node.start, node.end)) : {};
  return { ok: true, value, node, tree: parsed.tree };
}

/**
 * Set one entry inside a container object, creating the container when absent.
 * Returns `{ ok, text }`; unrelated bytes are preserved.
 */
export function writeContainerEntry(text, containerPath, key, value) {
  const source = typeof text === 'string' ? text : '';
  let parsed;
  try {
    parsed = parseJsonc(source);
  } catch (error) {
    return { ok: false, error: `parse error: ${error.message}` };
  }
  const unit = detectIndentUnit(source);
  if (!parsed.tree) {
    const fresh = { [containerPath]: { [key]: value } };
    return { ok: true, text: `${JSON.stringify(fresh, null, unit)}\n` };
  }
  if (parsed.tree.type !== 'object') {
    return { ok: false, error: 'root value is not an object' };
  }
  const container = findNode(parsed.tree, [containerPath]);
  if (!container) {
    const edit = insertionFor(source, parsed.tree, containerPath, { [key]: value });
    return { ok: true, text: applyEdits(source, [edit]) };
  }
  if (container.type !== 'object') {
    return { ok: false, error: `${containerPath} is not an object` };
  }
  const existing = container.pairs.find((pair) => pair.key === key);
  if (existing) {
    const edit = { start: existing.value.start, end: existing.value.end, text: JSON.stringify(value, null, unit).replace(/\n/g, `\n${indentOfLine(source, existing.pairStart)}`) };
    return { ok: true, text: applyEdits(source, [edit]) };
  }
  const edit = insertionFor(source, container, key, value);
  return { ok: true, text: applyEdits(source, [edit]) };
}

/** Remove one container entry; a no-op when the key is absent. */
export function removeContainerEntry(text, containerPath, key) {
  const source = typeof text === 'string' ? text : '';
  let parsed;
  try {
    parsed = parseJsonc(source);
  } catch (error) {
    return { ok: false, error: `parse error: ${error.message}` };
  }
  if (!parsed.tree) return { ok: true, text: source, changed: false };
  const container = findNode(parsed.tree, [containerPath]);
  if (!container || container.type !== 'object') return { ok: true, text: source, changed: false };
  const pair = container.pairs.find((item) => item.key === key);
  if (!pair) return { ok: true, text: source, changed: false };
  return { ok: true, text: applyEdits(source, [removalFor(source, container, pair)]), changed: true };
}

/** Rename one container entry in place (used for collision suffixing). */
export function renameContainerEntry(text, containerPath, from, to) {
  const source = typeof text === 'string' ? text : '';
  let parsed;
  try {
    parsed = parseJsonc(source);
  } catch (error) {
    return { ok: false, error: `parse error: ${error.message}` };
  }
  const container = parsed.tree ? findNode(parsed.tree, [containerPath]) : null;
  if (!container || container.type !== 'object') return { ok: false, error: 'container not found' };
  const pair = container.pairs.find((item) => item.key === from);
  if (!pair) return { ok: false, error: 'entry not found' };
  return { ok: true, text: applyEdits(source, [{ start: pair.keyStart, end: pair.keyStart + JSON.stringify(from).length, text: JSON.stringify(to) }]) };
}

/* ------------------------------------------------------------------ TOML --- */

const TOML_TABLE = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/;
const TOML_KEYVAL = /^\s*([A-Za-z0-9_."-]+)\s*=\s*(.*)$/;

function tomlSplitKeyPath(raw) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '\\') { current += ch + raw[i + 1]; i += 1; continue; }
      if (ch === '"') { quoted = false; continue; }
      current += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '.') { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  parts.push(current.trim());
  return parts.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

function tomlParseValue(raw) {
  const text = raw.trim().replace(/\s+#.*$/, '');
  if (text.startsWith('"') || text.startsWith("'")) {
    try {
      return text.startsWith('"') ? JSON.parse(text.slice(0, scanString(text, 0))) : text.slice(1, text.lastIndexOf("'"));
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith('[')) {
    try {
      const inner = text.slice(1, text.lastIndexOf(']'));
      const items = [];
      let i = 0;
      while (i < inner.length) {
        while (i < inner.length && ' ,\r\n\t'.includes(inner[i])) i += 1;
        if (i >= inner.length) break;
        if (inner[i] === '"' || inner[i] === "'") {
          const end = inner[i] === '"' ? scanString(inner, i) : inner.indexOf("'", i + 1) + 1;
          const chunk = inner.slice(i, end);
          items.push(chunk.startsWith('"') ? JSON.parse(chunk) : chunk.slice(1, -1));
          i = end;
          continue;
        }
        const comma = inner.indexOf(',', i);
        const stop = comma < 0 ? inner.length : comma;
        items.push(inner.slice(i, stop).trim());
        i = stop;
      }
      return items;
    } catch {
      return [];
    }
  }
  if (text.startsWith('{')) {
    const table = {};
    const inner = text.slice(1, text.lastIndexOf('}'));
    for (const piece of inner.split(',')) {
      const match = TOML_KEYVAL.exec(piece);
      if (!match) continue;
      table[match[1].replace(/^['"]|['"]$/g, '')] = tomlParseValue(match[2]);
    }
    return table;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  const number = Number(text);
  return Number.isFinite(number) && text !== '' ? number : text;
}

/** Split TOML into leading lines plus table blocks. */
export function tomlBlocks(text) {
  const lines = (typeof text === 'string' ? text : '').split('\n');
  const blocks = [];
  let current = { path: [], headerLine: -1, start: 0, lines: [] };
  for (let i = 0; i < lines.length; i += 1) {
    const match = TOML_TABLE.exec(lines[i]);
    if (match) {
      current.end = i;
      blocks.push(current);
      current = { path: tomlSplitKeyPath(match[1]), headerLine: i, start: i, lines: [lines[i]] };
      continue;
    }
    current.lines.push(lines[i]);
  }
  current.end = lines.length;
  blocks.push(current);
  return blocks;
}

/** Read every `[mcp_servers.<id>]` table into a plain object. */
export function readTomlServers(text) {
  const servers = {};
  for (const block of tomlBlocks(text)) {
    if (block.path[0] !== 'mcp_servers' || block.path.length < 2) continue;
    const name = block.path[1];
    const entry = servers[name] ?? (servers[name] = {});
    if (block.path.length === 2) {
      for (const line of block.lines) {
        const match = TOML_KEYVAL.exec(line);
        if (!match) continue;
        entry[match[1].replace(/^['"]|['"]$/g, '')] = tomlParseValue(match[2]);
      }
      continue;
    }
    // Nested sub-table, e.g. `[mcp_servers.x.env]` or `[mcp_servers.x.tools.foo]`.
    let target = entry;
    for (const key of block.path.slice(2)) {
      const next = target[key];
      if (next && typeof next === 'object' && !Array.isArray(next)) target = next;
      else target = target[key] = {};
    }
    for (const line of block.lines) {
      const match = TOML_KEYVAL.exec(line);
      if (!match) continue;
      target[match[1].replace(/^['"]|['"]$/g, '')] = tomlParseValue(match[2]);
    }
  }
  return servers;
}

function tomlQuote(value) {
  return JSON.stringify(String(value));
}

function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlQuote(key);
}

/** Render one server as TOML tables (base table plus nested tables). */
export function renderTomlServer(name, config) {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  const nested = [];
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      nested.push([key, value]);
      continue;
    }
    if (Array.isArray(value)) lines.push(`${tomlKey(key)} = [${value.map(tomlQuote).join(', ')}]`);
    else if (typeof value === 'number') lines.push(`${tomlKey(key)} = ${value}`);
    else if (typeof value === 'boolean') lines.push(`${tomlKey(key)} = ${value}`);
    else lines.push(`${tomlKey(key)} = ${tomlQuote(value)}`);
  }
  for (const [key, value] of nested) {
    lines.push('', `[mcp_servers.${tomlKey(name)}.${tomlKey(key)}]`);
    for (const [innerKey, innerValue] of Object.entries(value)) {
      if (innerValue === undefined || innerValue === null) continue;
      if (Array.isArray(innerValue)) lines.push(`${tomlKey(innerKey)} = [${innerValue.map(tomlQuote).join(', ')}]`);
      else if (typeof innerValue === 'number') lines.push(`${tomlKey(innerKey)} = ${innerValue}`);
      else if (typeof innerValue === 'boolean') lines.push(`${tomlKey(innerKey)} = ${innerValue}`);
      else lines.push(`${tomlKey(innerKey)} = ${tomlQuote(innerValue)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Remove every `[mcp_servers.<name>]` table (and its nested tables). */
export function removeTomlServer(text, name) {
  const source = typeof text === 'string' ? text : '';
  const lines = source.split('\n');
  const keep = [];
  let skip = false;
  for (let i = 0; i < lines.length; i += 1) {
    const match = TOML_TABLE.exec(lines[i]);
    if (match) {
      const path = tomlSplitKeyPath(match[1]);
      skip = path[0] === 'mcp_servers' && path[1] === name;
    }
    if (!skip) keep.push(lines[i]);
  }
  return keep.join('\n');
}

/** Replace one `[mcp_servers.<name>]` block, preserving every other byte. */
export function writeTomlServer(text, name, config) {
  const source = typeof text === 'string' ? text : '';
  const stripped = removeTomlServer(source, name).replace(/\n{3,}$/, '\n\n');
  const block = renderTomlServer(name, config);
  const base = stripped.trimEnd();
  return base ? `${base}\n\n${block}` : block;
}

/* ------------------------------------------------------------------ YAML --- */

/**
 * Extract `mcpServers` from a Continue-style YAML file. Indentation-based and
 * deliberately narrow: enough to list servers and their scalar fields, not a
 * general YAML parser.
 */
export function readYamlServers(text) {
  const lines = (typeof text === 'string' ? text : '').split('\n');
  const servers = {};
  let inBlock = false;
  let blockIndent = -1;
  let entryIndent = -1;
  let current = null;
  let lastKey = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!inBlock) {
      if (/^mcpServers\s*:/.test(trimmed)) {
        inBlock = true;
        blockIndent = indent;
      }
      continue;
    }
    if (indent <= blockIndent) break;
    const dash = /^-(?:\s+(.*))?$/.exec(trimmed);
    if (dash) {
      const body = (dash[1] ?? '').trim();
      // A dash indented deeper than the entry belongs to the previous key —
      // `args:` followed by `- -y` items. Treating these as entries would
      // invent a server named `-y`.
      if (current && indent > entryIndent) {
        if (lastKey) {
          const value = parseYamlScalar(body);
          const existing = current.entry[lastKey];
          if (Array.isArray(existing)) existing.push(value);
          else current.entry[lastKey] = [value];
        }
        continue;
      }
      entryIndent = indent;
      lastKey = null;
      const nameMatch = /^name\s*:\s*(.*)$/.exec(body);
      const name = nameMatch && nameMatch[1].trim() ? unquoteYaml(nameMatch[1]) : `server-${Object.keys(servers).length + 1}`;
      current = { name, entry: {} };
      servers[name] = current.entry;
      continue;
    }
    if (!current) continue;
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!pair) continue;
    lastKey = pair[1];
    current.entry[lastKey] = parseYamlScalar(pair[2]);
  }
  return servers;
}

function unquoteYaml(raw) {
  const text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text.replace(/\s+#.*$/, '');
}

function parseYamlScalar(raw) {
  const text = raw.trim();
  if (text === '') return '';
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).split(',').map((item) => unquoteYaml(item)).filter((item) => item !== '');
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return unquoteYaml(text);
}

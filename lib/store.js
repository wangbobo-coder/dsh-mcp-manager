/**
 * Durable state for the manager: the ownership ledger, backups, and the only
 * code path that touches client files on disk.
 *
 * Two rules make writes safe on files we do not own:
 *
 *   1. A write is a compare-and-set. The scan records a fingerprint of the file
 *      it read; the write refuses when the file has changed since, unless the
 *      caller explicitly forces it. Clients keep these files open and rewrite
 *      them on exit (Cursor and VS Code are the notorious ones), so an
 *      unconditional write is a lost-update bug waiting to happen.
 *   2. Every successful write leaves a timestamped backup plus a ledger entry
 *      carrying the previous bytes' hash, so a bad edit is one click from undo.
 *
 * The ledger lives in DSH_HOME so it survives plugin reinstalls and never sits
 * inside a project the user might commit.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function hashOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function createStore({ root, backupsToKeep = 20 }) {
  const ledgerPath = join(root, 'ledger.json');
  const backupsDir = join(root, 'backups');

  function ensureDirs() {
    mkdirSync(root, { recursive: true });
    mkdirSync(backupsDir, { recursive: true });
  }

  function readLedger() {
    try {
      const raw = readFileSync(ledgerPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        servers: parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : {},
        writes: Array.isArray(parsed.writes) ? parsed.writes : [],
      };
    } catch {
      return { version: 1, servers: {}, writes: [] };
    }
  }

  function writeLedger(ledger) {
    ensureDirs();
    const temp = `${ledgerPath}.tmp`;
    writeFileSync(temp, JSON.stringify(ledger, null, 2), 'utf8');
    renameSync(temp, ledgerPath);
  }

  /** Read one file, reporting absence distinctly from an empty file. */
  function readFile(path) {
    try {
      const text = readFileSync(path, 'utf8');
      return { ok: true, exists: true, text, hash: hashOf(text), mtimeMs: statSync(path).mtimeMs };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, exists: false, text: '', hash: null, mtimeMs: 0 };
      return { ok: false, exists: false, text: '', hash: null, error: String(error && error.message ? error.message : error) };
    }
  }

  /** Copy the current bytes aside before a mutation. */
  function backup(path, text) {
    if (text === undefined || text === null) return null;
    ensureDirs();
    const safe = path.replace(/[\\/:*?"<>|]+/g, '_');
    const file = join(backupsDir, `${safe}.${stamp()}.bak`);
    writeFileSync(file, text, 'utf8');
    pruneBackups(safe);
    return file;
  }

  function pruneBackups(safe) {
    try {
      const prefix = `${safe}.`;
      const matches = readdirSync(backupsDir).filter((name) => name.startsWith(prefix) && name.endsWith('.bak')).sort();
      const excess = matches.length - backupsToKeep;
      for (let index = 0; index < excess; index += 1) {
        try { rmSync(join(backupsDir, matches[index]), { force: true }); } catch { /* best effort */ }
      }
    } catch { /* backup pruning never blocks a write */ }
  }

  /**
   * Atomically replace a file. The temp file lives in the same directory so the
   * rename stays on one volume; a reader never observes a half-written config.
   */
  function writeFileAtomic(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.mcp-manager-${process.pid}-${Date.now()}.tmp`;
    writeFileSync(temp, text, 'utf8');
    try {
      renameSync(temp, path);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Apply one guarded mutation.
   *
   *   expectedHash — the fingerprint the caller believes is on disk (null when
   *                  the file is expected to be absent); a mismatch is a 409.
   *   mutate(text) — pure text→text; returns the new text, or `{ text }`.
   */
  function mutate({ path, clientId, scope, serverName, expectedHash, force = false, mutate, label = '' }) {
    const current = readFile(path);
    if (!current.ok) return { ok: false, code: 'error.file.read', error: current.error };
    const actualHash = current.hash;
    if (!force && expectedHash !== undefined && expectedHash !== actualHash) {
      return {
        ok: false,
        code: 'error.file.conflict',
        error: 'file changed on disk since it was read',
        conflict: { path, expected: expectedHash, actual: actualHash, mtimeMs: current.mtimeMs },
      };
    }
    let next;
    try {
      next = mutate(current.text);
    } catch (error) {
      return { ok: false, code: 'error.write.render', error: String(error && error.message ? error.message : error) };
    }
    if (next && typeof next === 'object' && 'ok' in next && next.ok === false) return next;
    const nextText = typeof next === 'string' ? next : next && typeof next.text === 'string' ? next.text : current.text;
    if (nextText === current.text) {
      return { ok: true, changed: false, path, hash: actualHash, backup: null };
    }
    const backupFile = current.exists ? backup(path, current.text) : null;
    try {
      writeFileAtomic(path, nextText);
    } catch (error) {
      return { ok: false, code: 'error.file.write', error: String(error && error.message ? error.message : error), backup: backupFile };
    }
    const nextHash = hashOf(nextText);
    const ledger = readLedger();
    ledger.writes.unshift({
      at: new Date().toISOString(),
      path,
      clientId,
      scope,
      serverName,
      label,
      beforeHash: actualHash,
      afterHash: nextHash,
      backup: backupFile,
      previousExisted: current.exists,
    });
    ledger.writes = ledger.writes.slice(0, 500);
    writeLedger(ledger);
    return { ok: true, changed: true, path, hash: nextHash, backup: backupFile };
  }

  function listBackups(limit = 50) {
    try {
      return readdirSync(backupsDir)
        .filter((name) => name.endsWith('.bak'))
        .sort()
        .reverse()
        .slice(0, limit)
        .map((name) => {
          const full = join(backupsDir, name);
          const info = statSync(full);
          return { name, path: full, size: info.size, at: info.mtime.toISOString() };
        });
    } catch {
      return [];
    }
  }

  /** Restore a backup file over its original path, itself backed up first. */
  function restore(backupFile, targetPath) {
    if (!existsSync(backupFile)) return { ok: false, code: 'error.backup.missing', error: 'backup file no longer exists' };
    const text = readFileSync(backupFile, 'utf8');
    const current = readFile(targetPath);
    if (current.exists) backup(targetPath, current.text);
    try {
      writeFileAtomic(targetPath, text);
    } catch (error) {
      return { ok: false, code: 'error.file.write', error: String(error && error.message ? error.message : error) };
    }
    return { ok: true, path: targetPath, hash: hashOf(text) };
  }

  /* ---------------------------------------------------------- ownership -- */

  /**
   * Record that a server exists in a file we manage. `fingerprint` is the
   * canonical server's hash, so a later scan can tell "the user edited this in
   * the client" apart from "we wrote it and nothing moved".
   *
   * `displayName` is the name the user sees, when it differs from the ledger key
   * (a harness mount is keyed by its `[A-Za-z0-9_-]` mount name). Keeping it lets
   * a later scan fold the mounted row back under the name the page renders, even
   * after the client that first declared it is gone.
   */
  function recordOwnership({ serverName, clientId, path, scope, fingerprint, source = 'managed', displayName }) {
    const ledger = readLedger();
    const bucket = ledger.servers[serverName] ?? (ledger.servers[serverName] = { targets: {}, createdAt: new Date().toISOString() });
    bucket.targets[`${clientId}:${scope}:${path}`] = {
      clientId, path, scope, fingerprint, source, displayName, lastWritten: new Date().toISOString(),
    };
    writeLedger(ledger);
    return bucket;
  }

  function forgetOwnership({ serverName, clientId, scope, path }) {
    const ledger = readLedger();
    const bucket = ledger.servers[serverName];
    if (!bucket) return false;
    delete bucket.targets[`${clientId}:${scope}:${path}`];
    if (Object.keys(bucket.targets).length === 0) delete ledger.servers[serverName];
    writeLedger(ledger);
    return true;
  }

  function ownershipOf(serverName) {
    const ledger = readLedger();
    return ledger.servers[serverName] ?? null;
  }

  function allOwnership() {
    return readLedger().servers;
  }

  function recentWrites(limit = 50) {
    return readLedger().writes.slice(0, limit);
  }

  return {
    root,
    ensureDirs,
    readFile,
    backup,
    writeFileAtomic,
    mutate,
    listBackups,
    restore,
    recordOwnership,
    forgetOwnership,
    ownershipOf,
    allOwnership,
    recentWrites,
    hashOf,
  };
}

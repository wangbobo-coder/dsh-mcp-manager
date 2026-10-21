/**
 * Client side of the MCP manager: one settings page listing every MCP server
 * found anywhere on this machine, grouped by the file that declares it.
 *
 * The page reads and writes only through the Host routes it registers, so the
 * agent tool and this UI share one implementation. Nothing here scans the
 * filesystem: a browser cannot, and pretending otherwise would produce a second
 * source of truth.
 *
 * The layout deliberately mirrors the skills page: a title row with actions, a
 * four-cell summary strip, a filter row, then one bordered card per source with
 * a collapsible head and a flat list of rows. Any deviation from that system is
 * a bug, not a preference — the two pages sit next to each other in the same
 * settings list.
 */

window.__ModuleLoader__.load({
  id: '@oh-agent/dsh-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;

    const NS = 'mcp-manager';
    const BASE = '/api/dsh-mcp-manager';

    /* ------------------------------------------------------------- locale -- */

    const DICT = {
      en: {
        title: 'MCP',
        desc: 'Every Model Context Protocol server on this machine, grouped by the file that declares it. The switch mounts a server in DeepSeek Harness — no other tool’s configuration is ever modified.',
        'btn.refresh': 'Refresh',
        'btn.reveal': 'Show values',
        'btn.hide': 'Mask values',
        'btn.probeAll': 'Test all',
        'btn.probe': 'Test',
        'btn.close': 'Close',
        'btn.sync': 'Copy to…',
        'btn.snippet': 'YAML row',
        'btn.history': 'Recent writes',
        'btn.restore': 'Restore',
        'btn.copy': 'Copy',
        'btn.copied': 'Copied',
        'btn.cancel': 'Cancel',
        'state.loading': 'Scanning local configuration…',
        'state.empty': 'No MCP servers configured in any detected tool.',
        'state.failed': 'Scan failed',
        'state.noMatch': 'No server matches these filters.',
        'summary.servers': 'servers',
        'summary.files': 'files',
        'summary.mounted': 'mounted in DSH',
        'summary.secrets': 'literal credentials',
        'filter.search': 'Filter by name, command or path',
        'filter.toolAll': 'All tools',
        'filter.statusAll': 'All servers',
        'filter.statusMounted': 'Mounted in DSH',
        'filter.statusUnmounted': 'Not mounted',
        'label.project': 'project',
        'label.global': 'global',
        'label.profile': 'profile',
        'label.readOnly': 'read-only',
        'label.pending': 'activating',
        'label.mounted': 'mounted',
        'label.off': 'off',
        'label.shared': 'in {count} files',
        'switch.title': 'Mount in DeepSeek Harness (this never edits {client})',
        'detail.targets': 'Declared in',
        'detail.definition': 'Definition',
        'detail.snippetTitle': 'Paste into a cordis composition to add the server:',
        'detail.secretWarn': 'This file stores credentials as literal text. Consider a variable reference instead.',
        'detail.history': 'Recent writes',
        'detail.noHistory': 'No writes recorded yet.',
        'detail.emptyFile': 'This file exists but declares no servers yet.',
        'probe.ok': 'healthy · {tools} tools · {ms}ms',
        'probe.failed': 'failed',
        'probe.tools': '{count} tools',
        'banner.secrets': '{count} server(s) store credentials as literal text in a configuration file that may be committed.',
        'banner.parse': '{count} file(s) could not be parsed.',
        'confirm.sync': 'Copy “{name}” into {count} other tool(s)?',
        'confirm.reveal': 'Show credential values in clear text?',
        'error.title': 'Something went wrong',
        'error.conflict': 'This file was changed by the tool itself since the scan. Refresh to reload it, then try again — nothing was written.',
        'error.projectScope': 'A project file is usually committed, so a plaintext credential is refused there. Write to the global scope instead, or replace the value with a variable reference.',
        'error.mount': 'DeepSeek Harness could not mount this server. The definition stays as it is in its own file.',
        'toast.mounted': 'Mounted “{name}” in DeepSeek Harness.',
        'toast.unmounted': 'Unmounted “{name}” from DeepSeek Harness.',
        'toast.mountPending': '“{name}” was written to the profile patch. Restart DeepSeek Harness to activate it.',
        'toast.mounting': '“{name}” is being activated by DeepSeek Harness — its tools appear in a moment.',
        'toast.restored': 'File restored.',
        'toast.copied': 'Copied to {count} tool(s).',
        'sync.none': 'No other tool can accept this definition.',
        'sync.title': 'Copy “{name}” into',
      },
      zh: {
        title: 'MCP',
        desc: '本机所有 Model Context Protocol 服务器，按声明它的配置文件分组。开关用于把服务器挂载到 DeepSeek Harness —— 不会修改任何其他工具的配置。',
        'btn.refresh': '刷新',
        'btn.reveal': '显示明文',
        'btn.hide': '隐藏明文',
        'btn.probeAll': '全部测试',
        'btn.probe': '测试',
        'btn.close': '关闭',
        'btn.sync': '复制到…',
        'btn.snippet': 'YAML 行',
        'btn.history': '最近写入',
        'btn.restore': '还原',
        'btn.copy': '复制',
        'btn.copied': '已复制',
        'btn.cancel': '取消',
        'state.loading': '正在扫描本机配置…',
        'state.empty': '已检测的工具中都没有配置 MCP 服务器。',
        'state.failed': '扫描失败',
        'state.noMatch': '没有符合筛选条件的服务器。',
        'summary.servers': '个服务器',
        'summary.files': '个文件',
        'summary.mounted': '已挂载到 DSH',
        'summary.secrets': '处明文凭据',
        'filter.search': '按名称、命令或路径筛选',
        'filter.toolAll': '全部工具',
        'filter.statusAll': '全部服务器',
        'filter.statusMounted': '已挂载到 DSH',
        'filter.statusUnmounted': '未挂载',
        'label.project': '项目',
        'label.global': '全局',
        'label.profile': 'profile',
        'label.readOnly': '只读',
        'label.pending': '正在激活',
        'label.mounted': '已挂载',
        'label.off': '未启用',
        'label.shared': '出现在 {count} 个文件',
        'switch.title': '挂载到 DeepSeek Harness（不会改动 {client} 本身）',
        'detail.targets': '声明位置',
        'detail.definition': '定义',
        'detail.snippetTitle': '粘贴到 cordis 组合文件即可加入该服务器：',
        'detail.secretWarn': '该文件以明文保存凭据，建议改为变量引用。',
        'detail.history': '最近写入',
        'detail.noHistory': '暂无写入记录。',
        'detail.emptyFile': '该文件存在，但还没有声明任何服务器。',
        'probe.ok': '正常 · {tools} 个工具 · {ms}ms',
        'probe.failed': '失败',
        'probe.tools': '{count} 个工具',
        'banner.secrets': '有 {count} 个服务器把凭据以明文保存在可能被提交的配置文件里。',
        'banner.parse': '有 {count} 个文件无法解析。',
        'confirm.sync': '把 “{name}” 复制到 {count} 个其他工具？',
        'confirm.reveal': '以明文显示凭据？',
        'error.title': '出错了',
        'error.conflict': '扫描之后该文件已被工具自身改动。请刷新后重试 —— 本次没有写入任何内容。',
        'error.projectScope': '项目级配置通常会被提交到仓库，因此不允许写入明文凭据。请改为写入全局作用域，或用变量引用代替明文。',
        'error.mount': 'DeepSeek Harness 无法挂载这个服务器。它在自己文件里的定义保持不变。',
        'toast.mounted': '已把 “{name}” 挂载到 DeepSeek Harness。',
        'toast.unmounted': '已从 DeepSeek Harness 卸载 “{name}”。',
        'toast.mountPending': '“{name}” 已写入 profile 补丁，重启 DeepSeek Harness 后生效。',
        'toast.mounting': 'DeepSeek Harness 正在激活 “{name}”，工具稍后即可调用。',
        'toast.restored': '文件已还原。',
        'toast.copied': '已复制到 {count} 个工具。',
        'sync.none': '没有其他工具能接受这个定义。',
        'sync.title': '把 “{name}” 复制到',
      },
    };

    function makeT(getActive) {
      return function t(key, params) {
        const locale = getActive();
        const table = DICT[locale] ?? DICT.en;
        let text = table[key] ?? DICT.en[key] ?? key;
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    /* ---------------------------------------------------------------- api -- */

    async function api(action, body) {
      const response = await fetch(`${BASE}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-mcp-manager': '1' },
        body: JSON.stringify(body ?? {}),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`non-JSON response (HTTP ${response.status})`);
      }
      if (!response.ok || !payload || payload.ok === false) {
        const reason = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
        const error = new Error(reason);
        error.code = payload?.code;
        error.hint = payload?.hint;
        error.conflict = payload?.conflict;
        throw error;
      }
      return payload.data;
    }

    async function fetchState(reveal) {
      const response = await fetch(`${BASE}/state${reveal ? '?reveal=1' : ''}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload || payload.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload.data;
    }

    /* -------------------------------------------------------------- styles -- */

    /*
     * Every rule below is a transcription of the skills page stylesheet with the
     * class prefix changed. Where a value differs it is because the content
     * differs (a file path instead of a git ref), never the visual language.
     */
    const CSS = `
.mcpm-root { box-sizing: border-box; display: flex; width: 100%; min-width: 0; flex-direction: column; gap: 14px;
  padding: 2px 0 36px; color: var(--dsw-alias-label-primary); font-family: inherit; }
/*
 * The container query context lives on an INNER wrapper, not on .mcpm-root.
 * container-type implies layout containment, and a layout-contained element
 * becomes the containing block for its position:fixed descendants — the detail
 * dialog would then be sized to this column and scroll away with it instead of
 * covering the viewport.
 */
.mcpm-main { display: flex; min-width: 0; flex-direction: column; gap: 14px; container-type: inline-size; }

.mcpm-head { display: flex; flex-direction: column; gap: 16px; }
.mcpm-title-row { display: flex; align-items: center; gap: 8px 12px; min-width: 0; flex-wrap: wrap; }
.mcpm-title-block { min-width: 0; flex: 1 1 auto; }
.mcpm-h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -.4px; white-space: nowrap; }
.mcpm-desc { margin: 12px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 22px; }
.mcpm-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex: none; margin-left: auto; }

.mcpm-btn { appearance: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; height: 30px; padding: 0 11px; border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, color 120ms ease; }
.mcpm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3, #555); }
.mcpm-btn:disabled { opacity: .5; cursor: default; }
.mcpm-btn:focus-visible { outline: var(--dsw-focus-ring-width, 1px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.mcpm-btn.sm { height: 24px; padding: 0 8px; font-size: 12px; border-radius: var(--dsw-radius-sm, 6px); }
.mcpm-btn.quiet { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.mcpm-btn.quiet:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mcpm-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.mcpm-btn.primary:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); opacity: .88; }

.mcpm-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-bg-layer-1); }
.mcpm-stat { min-width: 0; overflow: hidden; padding: 4px 10px; border-right: 0.5px solid var(--dsw-alias-border-l1);
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap; }
.mcpm-stat:last-child { border-right: 0; }
.mcpm-stat strong { margin-right: 4px; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 650; }
@container (max-width: 620px) {
  .mcpm-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mcpm-stat:nth-child(2) { border-right: 0; }
  .mcpm-stat:nth-child(-n+2) { border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
}
@container (max-width: 380px) {
  .mcpm-summary { grid-template-columns: 1fr; }
  .mcpm-stat { border-right: 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
  .mcpm-stat:last-child { border-bottom: 0; }
}

.mcpm-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; width: 100%; min-width: 0; }
.mcpm-search { box-sizing: border-box; flex: 1 1 200px; min-width: 0; height: 30px; padding: 0 11px;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.mcpm-search::placeholder { color: var(--dsw-alias-label-tertiary); }
.mcpm-search:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.mcpm-select { box-sizing: border-box; flex: 0 0 auto; max-width: 200px; height: 30px; padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.mcpm-select:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }

.mcpm-sources { display: flex; flex-direction: column; gap: 9px; }
.mcpm-source { flex-shrink: 0; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 20px); background: transparent; }
.mcpm-source-head { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 12px; }
.mcpm-source-toggle { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; overflow: hidden;
  padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mcpm-source-toggle:focus-visible { outline: var(--dsw-focus-ring-width, 1px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.mcpm-fold { flex: none; color: var(--dsw-alias-label-tertiary); transform: rotate(-90deg); transition: transform 160ms ease; }
.mcpm-fold.is-open { transform: rotate(0deg); }
.mcpm-source-label { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.mcpm-source-brand { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
  flex-shrink: 0; color: var(--dsw-alias-label-secondary); }
.mcpm-source-brand svg { display: block; width: 16px; height: 16px; }
.mcpm-source-title { font-size: 14px; font-weight: 650; white-space: nowrap; flex: none; }
.mcpm-count { flex: none; padding: 1px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2);
  font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mcpm-source-path { min-width: 0; max-width: 50%; margin-left: auto; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.mcpm-source-actions { display: flex; flex: none; align-items: center; gap: 8px; margin-left: 12px; }
@container (max-width: 560px) { .mcpm-source-path { display: none; } }

.mcpm-row { display: flex; align-items: center; gap: 8px; margin: 0; padding: 11px 13px;
  border-top: 0.5px solid var(--dsw-alias-border-l1); }
.mcpm-row-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1;
  padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mcpm-row-copy:focus-visible { outline: var(--dsw-focus-ring-width, 1px) solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: var(--dsw-radius-sm, 6px); }
.mcpm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 14px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.mcpm-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.mcpm-row-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: nowrap; }

.mcpm-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px;
  border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, #555); cursor: pointer; }
.mcpm-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.mcpm-switch:disabled { cursor: default; opacity: .5; }
.mcpm-switch:focus-visible { outline: var(--dsw-focus-ring-width, 1px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.mcpm-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #fff); transition: transform 120ms ease; pointer-events: none; }
.mcpm-switch[aria-checked="true"] .mcpm-switch-thumb { transform: translateX(16px); }

.mcpm-tag { flex: none; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.mcpm-tag.ok { color: var(--dsw-alias-state-success-primary); }
.mcpm-tag.warn { color: var(--dsw-alias-state-warn-primary); }
.mcpm-tag.err { color: var(--dsw-alias-state-error-primary); }
.mcpm-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.mcpm-dot.ok { background: var(--dsw-alias-state-success-primary); }
.mcpm-dot.err { background: var(--dsw-alias-state-error-primary); }

.mcpm-empty { padding: 25px 14px; color: var(--dsw-alias-label-tertiary); font-size: 12px; text-align: center; }
.mcpm-banner { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 16px);
  padding: 9px 11px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.mcpm-banner.warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.mcpm-error { border: 0.5px solid var(--dsw-alias-state-error-primary); border-radius: var(--dsw-radius-lg, 16px);
  padding: 9px 11px; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.mcpm-error-lines { display: flex; flex-direction: column; gap: 6px; }
.mcpm-toast { position: sticky; bottom: 8px; align-self: center; z-index: 5; padding: 6px 14px;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary); font-size: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, .18); }
.mcpm-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.mcpm-spin { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary);
  animation: mcpm-spin .7s linear infinite; vertical-align: -1px; }
@keyframes mcpm-spin { to { transform: rotate(360deg); } }

.mcpm-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(0, 0, 0, .42); }
.mcpm-modal { box-sizing: border-box; display: flex; flex-direction: column; width: 100%; max-width: 720px;
  max-height: min(80vh, 720px); overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 20px); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 18px 48px rgba(0, 0, 0, .32); }
.mcpm-modal-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.mcpm-modal-title { min-width: 0; }
.mcpm-modal-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: none; margin-left: auto; }
.mcpm-modal-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 16px; padding: 14px 16px; }

.mcpm-group { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.mcpm-group-title { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.mcpm-kv { display: grid; grid-template-columns: minmax(76px, max-content) 1fr; gap: 3px 14px; margin: 0;
  font-size: 12px; line-height: 18px; }
.mcpm-kv dt { color: var(--dsw-alias-label-secondary); }
.mcpm-kv dd { margin: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); font-size: 12px; }
.mcpm-pre { margin: 0; max-height: 220px; overflow: auto; padding: 10px 12px; border-radius: var(--dsw-radius-md, 12px);
  border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
  font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11.5px; line-height: 1.55; white-space: pre; }
.mcpm-check { display: flex; align-items: center; gap: 7px; padding: 3px 0; font-size: 12.5px; cursor: pointer; }
.mcpm-check input { accent-color: var(--dsw-alias-brand-primary); }
.mcpm-target { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 0; border-top: 0.5px solid var(--dsw-alias-border-l1); font-size: 12px; }
.mcpm-target:first-child { border-top: 0; }
.mcpm-target-name { flex: none; color: var(--dsw-alias-label-primary); }
.mcpm-target-path { min-width: 0; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-tertiary); font-size: 11px; }
@media (prefers-reduced-motion: reduce) {
  .mcpm-fold, .mcpm-switch-thumb { transition: none; }
  .mcpm-spin { animation: none; }
}
`;

    /* ----------------------------------------------------------- utilities -- */

    function transportLabel(transport) {
      if (transport === 'stdio') return 'stdio';
      if (transport === 'http-sse') return 'SSE';
      return 'HTTP';
    }

    function scopeLabel(t, scope) {
      if (scope === 'project') return t('label.project');
      if (scope === 'profile') return t('label.profile');
      return t('label.global');
    }

    /**
     * Shorten an absolute path for display only.
     *
     * The scanned path is the real one and stays in the payload (the detail view
     * and the tooltips show it in full); the card head only has room for a hint,
     * and `%APPDATA%\Qoder\SharedClientCache\mcp.json` answers "which directory"
     * in a third of the width of the absolute form. This is a pure string
     * transform — nothing is ever written back in this form.
     *
     * Both path flavours are handled because the adapter layer is cross-platform:
     * a macOS Host produces `/Users/me/Library/Application Support/...`, and
     * collapsing it to `~/Library/...` keeps the head uniform across platforms.
     */
    function shortenPath(path) {
      const text = String(path ?? '');
      if (!text || text.startsWith('(')) return text;
      return text
        .replace(/^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Roaming\\?/i, '%APPDATA%\\')
        .replace(/^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\?/i, '%LOCALAPPDATA%\\')
        .replace(/^[A-Za-z]:\\Users\\[^\\]+\\?/i, '~\\')
        .replace(/^\/(?:Users|home)\/[^/]+\/?/, '~/');
    }

    /**
     * One-line descriptor for a row: transport plus the command or URL.
     *
     * The full value is kept on `title` and shown in the detail view; the row
     * itself must never wrap, because a list where rows have different heights
     * is the difference between a table and a pile.
     */
    function metaLine(item) {
      const server = item.server ?? {};
      const transport = transportLabel(item.transport);
      const detail = item.transport === 'stdio'
        ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
        : String(server.url ?? '');
      return detail ? `${transport} · ${detail}` : transport;
    }

    function maskText(value) {
      const text = String(value ?? '');
      if (text.length <= 8) return '••••';
      return `${text.slice(0, 4)}••••${text.slice(-4)}`;
    }

    function looksSecret(key, value) {
      if (typeof value !== 'string') return false;
      if (!/(token|key|secret|password|passwd|credential|auth|cookie|session|private)/i.test(key)) return false;
      if (value.length < 12) return false;
      if (/^\$\{|\{\{|^%[A-Z_]+%$|^<.*>$|^\{env:/.test(value)) return false;
      return true;
    }

    function CopyButton({ t, text }) {
      const [done, setDone] = useState(false);
      return h('button', {
        className: 'mcpm-btn sm',
        onClick: async (event) => {
          event.stopPropagation();
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          } catch {
            setDone(false);
          }
        },
      }, done ? t('btn.copied') : t('btn.copy'));
    }

    function DefinitionList({ server, reveal }) {
      const rows = [];
      rows.push(['transport', transportLabel(server.transport)]);
      if (server.transport === 'stdio') {
        rows.push(['command', [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')]);
        if (server.cwd) rows.push(['cwd', server.cwd]);
      } else if (server.url) {
        rows.push(['url', server.url]);
      }
      rows.push(['enabled', String(server.enabled !== false)]);
      if (typeof server.timeoutMs === 'number') rows.push(['timeoutMs', String(server.timeoutMs)]);
      for (const [key, value] of Object.entries(server.env ?? {})) {
        const masked = !reveal && looksSecret(key, value) ? maskText(value) : String(value);
        rows.push([`env.${key}`, masked]);
      }
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        const masked = !reveal && looksSecret(key, value) ? maskText(value) : String(value);
        rows.push([`header.${key}`, masked]);
      }
      return h('dl', { className: 'mcpm-kv' }, rows.flatMap(([key, value]) => [
        h('dt', { key: `${key}-k` }, key),
        h('dd', { key: `${key}-v` }, value),
      ]));
    }

    /* --------------------------------------------------------------- page -- */

    /**
     * The mount switch.
     *
     * It renders `role="switch"` rather than a styled checkbox so the state is
     * announced to assistive technology and the thumb animation has a state to
     * key on — the same contract the skills page uses for its own switch.
     */
    function MountSwitch({ checked, disabled, onToggle, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'mcpm-switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title: label,
        disabled,
        onClick: (event) => {
          event.stopPropagation();
          onToggle(!checked);
        },
      }, h('span', { className: 'mcpm-switch-thumb' }));
    }

    const FILE_ICON = h('svg', {
      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    }, [
      h('path', { key: 'a', d: 'M3.5 1.5h5L12.5 5.5v9a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5v-12a.5.5 0 0 1 .5-.5Z' }),
      h('path', { key: 'b', d: 'M8.5 1.5v4h4' }),
    ]);

    const FOLD_ICON = h('svg', {
      width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    }, h('path', { d: 'M3 4.5 6 7.5l3-3' }));

    function McpManagerPage(props) {
      const ctx = props.__ctx;
      const t = makeT(() => ctx.locale.getLocale().active);

      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [reveal, setReveal] = useState(false);
      const [query, setQuery] = useState('');
      const [toolFilter, setToolFilter] = useState('all');
      const [statusFilter, setStatusFilter] = useState('all');
      const [openName, setOpenName] = useState(null);
      /*
       * Cards start COLLAPSED. With a dozen files and dozens of servers the page
       * opened as a wall of rows, and the thing the user actually navigates by is
       * the file list — the rows are the detail behind it. So the default is
       * closed, and only what the user opened (or what a filter matched) shows.
       */
      const [expanded, setExpanded] = useState({});
      const [probes, setProbes] = useState({});
      const [probing, setProbing] = useState({});
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState(null);
      const [snippet, setSnippet] = useState(null);
      const [syncOpen, setSyncOpen] = useState(false);
      const [syncPicks, setSyncPicks] = useState([]);
      const [historyOpen, setHistoryOpen] = useState(false);
      const mounted = useRef(true);

      useEffect(() => () => { mounted.current = false; }, []);

      const flash = useCallback((text) => {
        setToast(text);
        setTimeout(() => { if (mounted.current) setToast(null); }, 2800);
      }, []);

      const load = useCallback(async (nextReveal) => {
        setLoading(true);
        setError(null);
        try {
          const data = await fetchState(nextReveal ?? reveal);
          if (!mounted.current) return;
          setState(data);
        } catch (cause) {
          if (mounted.current) setError(cause);
        } finally {
          if (mounted.current) setLoading(false);
        }
      }, [reveal]);

      useEffect(() => { load(reveal); }, [reveal]);

      /* Escape closes the detail view, the way every other dialog here behaves. */
      useEffect(() => {
        if (!openName) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setOpenName(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [openName]);

      const installedClients = useMemo(() => {
        if (!state) return [];
        return state.clients
          .filter((client) => client.installed)
          .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
      }, [state]);

      /*
       * Mount state is a property of the SERVER NAME, not of the file it came
       * from: one name can be declared in five tools while being mounted in
       * DeepSeek Harness exactly once. Indexing it here keeps every row's
       * switch consistent with the DSH card.
       */
      const mountIndex = useMemo(() => {
        const index = new Map();
        if (!state) return index;
        for (const server of state.servers) {
          const dsh = server.targets.find((target) => target.clientId === 'dsh');
          index.set(server.name, {
            mounted: Boolean(dsh),
            enabled: dsh ? dsh.enabled !== false : false,
            pending: dsh?.pending === true,
            entryId: dsh?.entryId ?? null,
            node: server,
          });
        }
        return index;
      }, [state]);

      const sources = useMemo(() => {
        if (!state) return [];
        const order = new Map(installedClients.map((client, position) => [client.id, position]));
        return [...(state.sources ?? [])]
          .filter((source) => source.exists)
          .sort((left, right) => (order.get(left.clientId) ?? 99) - (order.get(right.clientId) ?? 99)
            || String(left.path).localeCompare(String(right.path)));
      }, [state, installedClients]);

      /*
       * Filtering happens on rows, not on cards: hiding a whole file because one
       * of its servers matched would hide the other matches. A file survives only
       * when at least one of its rows does, and an unfiltered view keeps the empty
       * files so the user can still see that a tool is installed but idle.
       */
      const filtering = query.trim() !== '' || toolFilter !== 'all' || statusFilter !== 'all';

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const out = [];
        for (const source of sources) {
          if (toolFilter !== 'all' && source.clientId !== toolFilter) continue;
          const rows = [];
          for (const item of source.servers) {
            const mount = mountIndex.get(item.name);
            const isMounted = Boolean(mount?.mounted && mount.enabled);
            if (statusFilter === 'mounted' && !isMounted) continue;
            if (statusFilter === 'unmounted' && isMounted) continue;
            if (needle) {
              const haystack = [
                item.name,
                item.transport,
                source.clientLabel?.en ?? '',
                source.path,
                item.server?.command ?? '',
                (item.server?.args ?? []).join(' '),
                item.server?.url ?? '',
              ].join(' ').toLowerCase();
              if (!haystack.includes(needle)) continue;
            }
            rows.push(item);
          }
          if (filtering && rows.length === 0) continue;
          out.push({ source, rows: rows.sort((left, right) => left.name.localeCompare(right.name)) });
        }
        return out;
      }, [sources, query, toolFilter, statusFilter, mountIndex, filtering]);

      const openServer = useMemo(
        () => (state && openName ? state.servers.find((server) => server.name === openName) : null),
        [state, openName],
      );

      const mountedCount = useMemo(
        () => [...mountIndex.values()].filter((item) => item.mounted && item.enabled).length,
        [mountIndex],
      );

      const run = async (action, body, success, after) => {
        setBusy(true);
        setError(null);
        try {
          const data = await api(action, body);
          if (data?.state) {
            /* The toggle answers with the fresh snapshot; reuse it instead of a second round trip. */
            if (mounted.current) setState(data.state);
          } else {
            await load(reveal);
          }
          if (success) flash(success);
          if (after) after(data);
          return data;
        } catch (cause) {
          setError(cause);
          return null;
        } finally {
          setBusy(false);
        }
      };

      const probeOne = async (name) => {
        setProbing((current) => ({ ...current, [name]: true }));
        try {
          const data = await api('probe', { names: [name] });
          setProbes((current) => ({ ...current, ...(data?.results ?? {}) }));
        } catch (cause) {
          setError(cause);
        } finally {
          setProbing((current) => ({ ...current, [name]: false }));
        }
      };

      const probeAll = async () => {
        const names = state ? state.servers.map((server) => server.name) : [];
        setProbing(Object.fromEntries(names.map((name) => [name, true])));
        try {
          const data = await api('probe', {});
          setProbes((current) => ({ ...current, ...(data?.results ?? {}) }));
        } catch (cause) {
          setError(cause);
        } finally {
          setProbing({});
        }
      };

      /*
       * One switch, one meaning: "mounted in DeepSeek Harness".
       *
       * Turning it on mounts the server there (writing our own profile patch when
       * no Loader row exists yet). Turning it off unmounts it. The file the
       * definition came from is never opened for writing.
       *
       * A freshly written patch row is reconciled by the Loader a moment later,
       * so `activating` is not an error and certainly not a restart demand: the
       * page says it is coming up and re-reads the state shortly after.
       */
      const toggleMount = async (name, next) => {
        const result = await run('toggle', { name, enabled: next }, null, (data) => {
          if (data?.restartRequired) flash(t('toast.mountPending', { name }));
          else if (next && data?.activating) {
            flash(t('toast.mounting', { name }));
            setTimeout(() => { void load(reveal); }, 2500);
          } else flash(next ? t('toast.mounted', { name }) : t('toast.unmounted', { name }));
        });
        if (!result) flash(t('error.mount'));
      };

      const doSync = async (server) => {
        if (!window.confirm(t('confirm.sync', { name: server.name, count: syncPicks.length }))) return;
        const data = await run('sync', { name: server.name, server: server.canonical, targets: syncPicks });
        if (data) {
          setSyncOpen(false);
          flash(t('toast.copied', { count: (data.results ?? []).filter((item) => item.ok).length }));
        }
      };

      const openSnippet = async (server) => {
        const data = await run('snippet', { name: server.name });
        if (data) setSnippet(data.yaml);
      };

      const toggleReveal = async () => {
        const next = !reveal;
        if (next && !window.confirm(t('confirm.reveal'))) return;
        setReveal(next);
      };

      const closeDetail = () => {
        setOpenName(null);
        setSnippet(null);
        setSyncOpen(false);
      };

      /* ------------------------------------------------------------ render -- */

      const header = h('div', { className: 'mcpm-head' }, [
        h('div', { className: 'mcpm-title-row', key: 'title' }, [
          h('div', { className: 'mcpm-title-block', key: 'block' }, h('h1', { className: 'mcpm-h1' }, t('title'))),
          h('div', { className: 'mcpm-actions', key: 'actions' }, [
            h('button', {
              key: 'probe',
              className: 'mcpm-btn',
              disabled: busy || loading || !state || state.servers.length === 0,
              onClick: probeAll,
            }, t('btn.probeAll')),
            h('button', {
              key: 'reveal',
              className: 'mcpm-btn',
              disabled: loading || !state,
              onClick: toggleReveal,
            }, reveal ? t('btn.hide') : t('btn.reveal')),
            h('button', {
              key: 'refresh',
              className: 'mcpm-btn',
              disabled: loading,
              onClick: () => load(reveal),
            }, t('btn.refresh')),
          ]),
        ]),
        h('p', { className: 'mcpm-desc', key: 'desc' }, t('desc')),
      ]);

      const summary = state ? h('div', { className: 'mcpm-summary', key: 'summary' }, [
        h('div', { className: 'mcpm-stat', key: 'servers' }, [h('strong', { key: 'v' }, String(state.servers.length)), t('summary.servers')]),
        h('div', { className: 'mcpm-stat', key: 'files' }, [h('strong', { key: 'v' }, String(sources.length)), t('summary.files')]),
        h('div', { className: 'mcpm-stat', key: 'mounted' }, [h('strong', { key: 'v' }, String(mountedCount)), t('summary.mounted')]),
        h('div', { className: 'mcpm-stat', key: 'secrets' }, [h('strong', { key: 'v' }, String(state.literalSecrets.length)), t('summary.secrets')]),
      ]) : null;

      const filters = state ? h('div', { className: 'mcpm-filters', key: 'filters' }, [
        h('input', {
          key: 'q',
          type: 'search',
          className: 'mcpm-search',
          placeholder: t('filter.search'),
          'aria-label': t('filter.search'),
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        h('select', {
          key: 'tool',
          className: 'mcpm-select',
          'aria-label': t('filter.toolAll'),
          value: toolFilter,
          onChange: (event) => setToolFilter(event.target.value),
        }, [
          h('option', { key: 'all', value: 'all' }, t('filter.toolAll')),
          ...installedClients.map((client) => h('option', {
            key: client.id,
            value: client.id,
          }, client.label?.en ?? client.id)),
        ]),
        h('select', {
          key: 'status',
          className: 'mcpm-select',
          'aria-label': t('filter.statusAll'),
          value: statusFilter,
          onChange: (event) => setStatusFilter(event.target.value),
        }, [
          h('option', { key: 'all', value: 'all' }, t('filter.statusAll')),
          h('option', { key: 'mounted', value: 'mounted' }, t('filter.statusMounted')),
          h('option', { key: 'unmounted', value: 'unmounted' }, t('filter.statusUnmounted')),
        ]),
      ]) : null;

      const banners = state ? [
        state.literalSecrets.length
          ? h('div', { className: 'mcpm-banner warn', key: 'secrets' }, t('banner.secrets', { count: state.literalSecrets.length }))
          : null,
        state.warnings.length
          ? h('div', { className: 'mcpm-banner warn', key: 'parse' }, t('banner.parse', { count: state.warnings.length }))
          : null,
      ].filter(Boolean) : [];

      const probeTag = (name) => {
        if (probing[name]) return h('span', { className: 'mcpm-spin', key: 'p' });
        const probe = probes[name];
        if (!probe) return null;
        const ok = probe.status === 'ok';
        return h('span', { className: 'mcpm-tag' + (ok ? ' ok' : ' err'), key: 'p', title: ok
          ? t('probe.ok', { tools: probe.toolCount, ms: probe.elapsedMs })
          : (probe.detail ?? t('probe.failed')) }, [
          h('span', { className: 'mcpm-dot' + (ok ? ' ok' : ' err'), key: 'd' }),
          ' ',
          ok ? t('probe.tools', { count: probe.toolCount }) : t('probe.failed'),
        ]);
      };

      const rowFor = (source, item) => {
        const mount = mountIndex.get(item.name);
        const node = mount?.node ?? null;
        const checked = Boolean(mount?.mounted && mount.enabled);
        const shared = node ? node.clientCount : 1;
        const isDsh = source.clientId === 'dsh';

        const copy = h('button', {
          key: 'copy',
          type: 'button',
          className: 'mcpm-row-copy',
          onClick: () => setOpenName(item.name),
        }, [
          h('div', { className: 'mcpm-name', key: 'n', title: item.name }, item.name),
          h('div', { className: 'mcpm-meta', key: 'd', title: metaLine(item) }, metaLine(item)),
        ]);

        return h('div', { className: 'mcpm-row', key: item.name }, [
          copy,
          h('div', { className: 'mcpm-row-actions', key: 'a' }, [
            shared > 1 ? h('span', { className: 'mcpm-tag', key: 'sh', title: node?.clients?.join(', ') ?? '' }, t('label.shared', { count: shared })) : null,
            mount?.pending ? h('span', { className: 'mcpm-tag warn', key: 'pd' }, t('label.pending')) : null,
            isDsh && !checked ? h('span', { className: 'mcpm-tag', key: 'off' }, t('label.off')) : null,
            probeTag(item.name),
            h(MountSwitch, {
              key: 'sw',
              checked,
              /*
               * Any in-flight write locks every switch, not just its own row: two
               * concurrent toggles would both read the composition and the second
               * would write a file the first one already replaced.
               */
              disabled: busy,
              label: t('switch.title', { client: source.clientLabel?.en ?? source.clientId }),
              onToggle: (next) => toggleMount(item.name, next),
            }),
          ]),
        ]);
      };

      const sourceCard = (entry) => {
        const { source } = entry;
        /* While filtering, every card opens: a match hidden inside a closed card
           reads as "no results" and the user would keep typing. */
        const isOpen = filtering || expanded[source.id] === true;
        const rows = entry.rows;
        const label = source.clientLabel?.en ?? source.clientId;
        return h('section', { className: 'mcpm-source', key: source.id }, [
          h('div', { className: 'mcpm-source-head', key: 'head' }, [
            h('button', {
              key: 'toggle',
              type: 'button',
              className: 'mcpm-source-toggle',
              'aria-expanded': isOpen ? 'true' : 'false',
              onClick: () => setExpanded((current) => ({ ...current, [source.id]: !isOpen })),
            }, [
              h('span', { className: 'mcpm-fold' + (isOpen ? ' is-open' : ''), key: 'f' }, FOLD_ICON),
              h('span', { className: 'mcpm-source-label', key: 'l' }, [
                h('span', { className: 'mcpm-source-brand', key: 'b', title: source.format }, FILE_ICON),
                h('span', { className: 'mcpm-source-title', key: 't' }, label),
                h('span', { className: 'mcpm-count', key: 'n' }, String(source.serverCount)),
                source.readOnly ? h('span', { className: 'mcpm-tag', key: 'ro' }, t('label.readOnly')) : null,
                h('span', { className: 'mcpm-source-path', key: 'p', title: source.path }, shortenPath(source.path)),
              ]),
            ]),
            h('span', { className: 'mcpm-source-actions', key: 'actions' },
              h('span', { className: 'mcpm-tag' }, scopeLabel(t, source.scope))),
          ]),
          isOpen ? h('div', { key: 'body' }, rows.length === 0
            ? h('div', { className: 'mcpm-empty', key: 'e' }, t('detail.emptyFile'))
            : rows.map((item) => rowFor(source, item))) : null,
        ]);
      };

      const historyCard = historyOpen && state ? h('section', { className: 'mcpm-source', key: 'history' }, [
        h('div', { className: 'mcpm-source-head', key: 'head' }, h('div', { className: 'mcpm-source-label' }, [
          h('span', { className: 'mcpm-source-brand', key: 'b' }, FILE_ICON),
          h('span', { className: 'mcpm-source-title', key: 't' }, t('detail.history')),
          h('span', { className: 'mcpm-count', key: 'n' }, String((state.history ?? []).length)),
        ])),
        (state.history ?? []).length === 0
          ? h('div', { className: 'mcpm-empty', key: 'e' }, t('detail.noHistory'))
          : (state.history ?? []).slice(0, 12).map((item, index) => h('div', { className: 'mcpm-row', key: index }, [
            h('div', { className: 'mcpm-row-copy', key: 'c', style: { cursor: 'default' } }, [
              h('div', { className: 'mcpm-name', key: 'n' }, `${item.label ?? item.action ?? 'write'} · ${item.serverName ?? ''}`),
              h('div', { className: 'mcpm-meta', key: 'm', title: item.path }, `${new Date(item.at).toLocaleString()} · ${shortenPath(item.path)}`),
            ]),
            item.backup
              ? h('div', { className: 'mcpm-row-actions', key: 'a' }, h('button', {
                key: 'r', className: 'mcpm-btn sm',
                disabled: busy,
                onClick: async () => { await run('restore', { backup: item.backup, path: item.path }, t('toast.restored')); },
              }, t('btn.restore')))
              : null,
          ])),
      ]) : null;

      /*
       * The detail view is a dialog, not an expanding row.
       *
       * Inline expansion reflows every row below it and — because the body is
       * taller than a row — makes the card look like two cards stacked. The skills
       * page answers this the same way: a modal over the list, dismissed with
       * Escape or a click outside.
       */
      const detailModal = openServer ? (() => {
        const server = openServer;
        const mount = mountIndex.get(server.name);
        const otherTargets = installedClients.filter((client) => !client.readOnly
          && client.id !== 'dsh'
          && !server.targets.some((target) => target.clientId === client.id));
        /*
         * Targets normally carry their own label, but the label is presentation
         * data the Host may omit (a target written before a client was renamed,
         * or a hand-built payload). Fall back to the catalog row so the dialog
         * never shows a raw id where every other view shows a tool name.
         */
        const clientLabel = (target) => target.clientLabel?.en
          ?? state.clients.find((client) => client.id === target.clientId)?.label?.en
          ?? target.clientId;
        return h('div', {
          className: 'mcpm-overlay',
          key: 'detail',
          role: 'presentation',
          onClick: closeDetail,
        }, h('div', {
          className: 'mcpm-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': server.name,
          onClick: (event) => event.stopPropagation(),
        }, [
          h('div', { className: 'mcpm-modal-head', key: 'head' }, [
            h('div', { className: 'mcpm-modal-title', key: 'l' }, [
              h('div', { className: 'mcpm-name', key: 'n' }, server.name),
              h('div', { className: 'mcpm-meta', key: 'm' }, [
                transportLabel(server.transport),
                mount?.mounted ? ` · ${mount.enabled ? t('label.mounted') : t('label.off')}` : '',
              ].join('')),
            ]),
            h('div', { className: 'mcpm-modal-actions', key: 'r' }, [
              h('button', {
                key: 'p', className: 'mcpm-btn sm', disabled: busy,
                onClick: () => probeOne(server.name),
              }, t('btn.probe')),
              h('button', {
                key: 'y', className: 'mcpm-btn sm', disabled: busy,
                onClick: () => openSnippet(server),
              }, t('btn.snippet')),
              h('button', {
                key: 's', className: 'mcpm-btn sm', disabled: busy || otherTargets.length === 0,
                onClick: () => { setSyncPicks([]); setSnippet(null); setSyncOpen(!syncOpen); },
              }, t('btn.sync')),
              h('button', { key: 'c', className: 'mcpm-btn sm quiet', onClick: closeDetail }, t('btn.close')),
            ]),
          ]),

          h('div', { className: 'mcpm-modal-body', key: 'body' }, [
            h('div', { className: 'mcpm-group', key: 'targets' }, [
              h('div', { className: 'mcpm-group-title', key: 't' }, t('detail.targets')),
              ...server.targets.map((target) => h('div', { className: 'mcpm-target', key: `${target.clientId}:${target.path}` }, [
                h('span', { className: 'mcpm-target-name', key: 'n' }, clientLabel(target)),
                target.pending ? h('span', { className: 'mcpm-tag warn', key: 'pd' }, t('label.pending')) : null,
                target.server?.enabled === false ? h('span', { className: 'mcpm-tag', key: 'off' }, t('label.off')) : null,
                h('span', { className: 'mcpm-target-path', key: 'p', title: target.path }, shortenPath(target.path)),
              ])),
            ]),

            h('div', { className: 'mcpm-group', key: 'def' }, [
              h('div', { className: 'mcpm-group-title', key: 't' }, t('detail.definition')),
              h(DefinitionList, { key: 'l', server: server.canonical, reveal }),
            ]),

            snippet ? h('div', { className: 'mcpm-group', key: 'snip' }, [
              h('div', { className: 'mcpm-group-title', key: 't' }, t('detail.snippetTitle')),
              h('pre', { className: 'mcpm-pre', key: 'p' }, snippet),
              h('div', { key: 'a' }, h(CopyButton, { t, text: snippet })),
            ]) : null,

            syncOpen ? h('div', { className: 'mcpm-group', key: 'sync' }, [
              h('div', { className: 'mcpm-group-title', key: 't' }, t('sync.title', { name: server.name })),
              otherTargets.length === 0
                ? h('div', { className: 'mcpm-muted', key: 'n' }, t('sync.none'))
                : otherTargets.map((client) => h('label', { className: 'mcpm-check', key: client.id }, [
                  h('input', {
                    key: 'i',
                    type: 'checkbox',
                    checked: syncPicks.some((pick) => pick.clientId === client.id),
                    onChange: (event) => {
                      setSyncPicks((current) => (event.target.checked
                        ? [...current, { clientId: client.id, scope: 'global' }]
                        : current.filter((pick) => pick.clientId !== client.id)));
                    },
                  }),
                  client.label?.en ?? client.id,
                ])),
              h('div', { key: 'a', style: { display: 'flex', gap: 8 } }, [
                h('button', {
                  key: 'go', className: 'mcpm-btn primary sm',
                  disabled: busy || syncPicks.length === 0,
                  onClick: () => doSync(server),
                }, t('btn.sync')),
                h('button', { key: 'x', className: 'mcpm-btn sm quiet', onClick: () => setSyncOpen(false) }, t('btn.cancel')),
              ]),
            ]) : null,

            server.targets.some((target) => target.server?.secrets?.length)
              ? h('div', { className: 'mcpm-banner warn', key: 'sec' }, t('detail.secretWarn'))
              : null,
          ]),
        ]));
      })() : null;

      let body;
      if (loading && !state) {
        body = h('div', { className: 'mcpm-empty' }, [h('span', { className: 'mcpm-spin', key: 's' }), ' ', t('state.loading')]);
      } else if (error && !state) {
        body = h('div', { className: 'mcpm-error' }, `${t('state.failed')}: ${error.message}`);
      } else if (state && sources.length === 0) {
        body = h('div', { className: 'mcpm-empty' }, t('state.empty'));
      } else if (state) {
        body = h('div', { className: 'mcpm-sources', key: 'list' }, visible.length === 0
          ? [h('div', { className: 'mcpm-empty', key: 'none' }, t('state.noMatch'))]
          : visible.map(sourceCard));
      } else {
        body = null;
      }

      return h('div', { className: 'mcpm-root' }, [
        h('style', { key: 'style' }, CSS),
        /*
         * Page content lives inside .mcpm-main so the container-query context
         * (which implies layout containment) never wraps the dialog below.
         */
        h('div', { className: 'mcpm-main', key: 'main' }, [
          header,
          summary,
          filters,
          ...banners,
          /*
           * An error with a live snapshot is an action failure, not a scan failure:
           * it belongs under the controls, next to the thing that failed, and the
           * list below stays usable.
           */
          error && state ? h('div', { className: 'mcpm-error', key: 'err' }, h('div', { className: 'mcpm-error-lines' }, [
            h('div', { key: 'msg' }, `${t('error.title')}: ${error.message}${error.hint ? ` — ${error.hint}` : ''}`),
            /*
             * A conflict is not a failure the user can retry blindly: the file
             * changed under us, so the only correct next step is to re-read it and
             * decide again. Offer that instead of leaving a dead end.
             */
            error.code === 'error.file.conflict' ? h('div', { key: 'conflict' }, [
              h('div', { key: 't' }, t('error.conflict')),
              h('button', { key: 'b', className: 'mcpm-btn sm', onClick: () => load(reveal) }, t('btn.refresh')),
            ]) : null,
            /*
             * A credential refusal is actionable: the fix is to write to the global
             * scope, or to store an indirection instead of the value.
             */
            error.code === 'error.secret.projectScope' ? h('div', { key: 'secret' }, t('error.projectScope')) : null,
            error.code === 'error.toggle.notMounted' ? h('div', { key: 'mount' }, t('error.mount')) : null,
          ])) : null,
          body,
          state ? h('div', { key: 'foot', style: { display: 'flex' } }, h('button', {
            className: 'mcpm-btn sm quiet',
            onClick: () => setHistoryOpen(!historyOpen),
          }, t('btn.history'))) : null,
          historyCard,
        ]),
        detailModal,
        toast ? h('div', { className: 'mcpm-toast', key: 'toast' }, toast) : null,
      ]);
    }

    /* --------------------------------------------------------------- apply -- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeT(() => ctx.locale.getLocale().active);
        ctx.effect(() => ctx.locale.register(NS, DICT), 'mcp-manager dictionaries');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-manager',
          order: 26,
          label: () => t('title'),
          locale: NS,
        }, (ownerProps) => h(McpManagerPage, { ...ownerProps, __ctx: ctx })));
      },
    };
  },
});

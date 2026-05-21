"use strict";

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");
const { CODEX_OFFICIAL_HOOK_SOURCE } = require("./server-codex-official-turns");
const {
  truncateDeep,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeHookToolUseId,
  normalizeCodexPermissionToolInput,
  buildToolInputFingerprint,
} = require("./server-permission-utils");

const MAX_PERMISSION_BODY_BYTES = 524288;
const ANTIGRAVITY_PERMISSION_OVERRIDE_STRING_MAX = 240;

function normalizeAntigravityPermissionOverride(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > ANTIGRAVITY_PERMISSION_OVERRIDE_STRING_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function firstStringField(input, names) {
  if (!input || typeof input !== "object") return null;
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeAntigravityToolName(toolName) {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
}

function isAntigravityNativeCommandTool(toolName) {
  const name = normalizeAntigravityToolName(toolName);
  return name === "run_command" || name === "bash" || name === "shell";
}

function isAntigravityAbsolutePath(value) {
  return typeof value === "string" && (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function joinAntigravityPath(cwd, target) {
  const rawTarget = typeof target === "string" ? target.trim() : "";
  if (!rawTarget || isAntigravityAbsolutePath(rawTarget)) return rawTarget;
  const rawCwd = typeof cwd === "string" ? cwd.trim() : "";
  if (!rawCwd) return rawTarget;
  const sep = rawCwd.includes("\\") && !rawCwd.includes("/") ? "\\" : "/";
  return `${rawCwd.replace(/[\\/]+$/, "")}${sep}${rawTarget.replace(/^[\\/]+/, "")}`;
}

function firstAntigravityPath(input, names) {
  const value = firstStringField(input, names);
  if (!value) return null;
  return joinAntigravityPath(input && input.Cwd, value);
}

function splitAntigravityCommandRoot(command) {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) return "";
  const withoutCall = text.startsWith("&") ? text.slice(1).trim() : text;
  const quoted = withoutCall.match(/^"([^"]+)"/) || withoutCall.match(/^'([^']+)'/);
  if (quoted) return quoted[1].trim();
  const first = withoutCall.match(/^\S+/);
  return first ? first[0].trim() : "";
}

function pushAntigravityCommandOverrides(rawOverrides, command) {
  if (/[\u0000-\u001f\u007f]/.test(command)) return;
  const root = splitAntigravityCommandRoot(command);
  if (root && root !== command) rawOverrides.push(`command(${root})`);
  if (command) rawOverrides.push(`command(${command})`);
}

function inferAskPermissionOverride(input) {
  const target = firstStringField(input, ["Target", "target", "Permission", "permission"]);
  if (!target) return null;
  if (/^[a-z_]+\(.+\)$/.test(target)) return target;

  const action = (firstStringField(input, ["Action", "action"]) || "").toLowerCase();
  if (action.includes("read")) return `read_file(${joinAntigravityPath(input && input.Cwd, target)})`;
  if (action.includes("write") || action.includes("edit")) {
    return `write_file(${joinAntigravityPath(input && input.Cwd, target)})`;
  }
  if (action.includes("command") || action.includes("bash") || action.includes("shell") || action.includes("run")) return `command(${target})`;
  return null;
}

function buildAntigravityPermissionOverrides(toolName, toolInput) {
  const name = normalizeAntigravityToolName(toolName);
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const rawOverrides = [];

  if (isAntigravityNativeCommandTool(name)) {
    const command = firstStringField(input, ["CommandLine", "command", "Command", "cmd"]);
    if (command) pushAntigravityCommandOverrides(rawOverrides, command);
  } else if (name === "view_file" || name === "read") {
    const filePath = firstAntigravityPath(input, ["AbsolutePath", "file_path", "path", "filePath", "FilePath"]);
    if (filePath) rawOverrides.push(`read_file(${filePath})`);
  } else if (
    name === "write_to_file" ||
    name === "replace_file_content" ||
    name === "multi_replace_file_content" ||
    name === "write" ||
    name === "edit" ||
    name === "multiedit"
  ) {
    const filePath = firstAntigravityPath(input, ["TargetFile", "AbsolutePath", "file_path", "path", "filePath", "FilePath"]);
    if (filePath) rawOverrides.push(`write_file(${filePath})`);
  } else if (name === "list_dir") {
    const dirPath = firstAntigravityPath(input, ["DirectoryPath", "path", "directory"]);
    if (dirPath) rawOverrides.push(`read_file(${dirPath})`);
  } else if (name === "find_by_name") {
    const searchPath = firstAntigravityPath(input, ["SearchDirectory", "DirectoryPath", "path"]);
    if (searchPath) rawOverrides.push(`read_file(${searchPath})`);
  } else if (name === "grep_search") {
    const searchPath = firstAntigravityPath(input, ["SearchPath", "SearchDirectory", "DirectoryPath", "path"]);
    if (searchPath) rawOverrides.push(`read_file(${searchPath})`);
  } else if (name === "ask_permission") {
    const override = inferAskPermissionOverride(input);
    const commandMatch = override && override.match(/^command\((.+)\)$/);
    if (commandMatch) {
      pushAntigravityCommandOverrides(rawOverrides, commandMatch[1]);
    } else if (override) {
      rawOverrides.push(override);
    }
  }

  return rawOverrides
    .map(normalizeAntigravityPermissionOverride)
    .filter(Boolean);
}

// ExitPlanMode (Plan Review) and AskUserQuestion (elicitation) happen to
// travel through /permission, but they're UX flows — not approvals the
// sub-gate is named for. Silencing them would break plan-mode and leave
// CC hanging on an elicitation.
//
// The aggregate/split permission bubble gates are also honored here:
// dropping the HTTP connection lets CC/codebuddy fall back to their terminal
// chat prompt. The previous behavior merely skipped showPermissionBubble,
// leaving the request parked in pendingPermissions — CC would then hang for
// 600s before timing out with nothing in the terminal.
function shouldBypassCCBubble(ctx, toolName, agentId) {
  if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") return false;
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled(agentId);
}

function shouldBypassOpencodeBubble(ctx) {
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("opencode");
}

function shouldBypassPiBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("pi");
}

function shouldBypassAntigravityBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("antigravity-cli");
}

function shouldBypassCodexBubble(ctx) {
  if (!arePermissionBubblesEnabled(ctx)) return true;
  if (typeof ctx.isAgentPermissionsEnabled !== "function") return false;
  return !ctx.isAgentPermissionsEnabled("codex");
}

function shouldInterceptCodexPermission(ctx) {
  if (typeof ctx.isCodexPermissionInterceptEnabled !== "function") return true;
  return ctx.isCodexPermissionInterceptEnabled();
}

function arePermissionBubblesEnabled(ctx) {
  if (typeof ctx.getBubblePolicy === "function") {
    try {
      const policy = ctx.getBubblePolicy("permission");
      if (policy && typeof policy.enabled === "boolean") return policy.enabled;
    } catch {}
  }
  return !ctx.hideBubbles;
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePositiveInteger(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function buildCodexPermissionSessionOptions(data) {
  const sourcePid = normalizePositiveInteger(data.source_pid);
  const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
  const agentPid = normalizePositiveInteger(rawAgentPid);
  const pidChain = Array.isArray(data.pid_chain)
    ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    : null;
  const options = {
    agentId: "codex",
    hookSource: CODEX_OFFICIAL_HOOK_SOURCE,
  };

  if (sourcePid) options.sourcePid = sourcePid;
  if (agentPid) options.agentPid = agentPid;
  if (pidChain && pidChain.length) options.pidChain = pidChain;
  const cwd = normalizeString(data.cwd);
  const host = normalizeString(data.host);
  const platform = normalizeString(data.platform);
  const model = normalizeString(data.model);
  const codexOriginator = normalizeString(data.codex_originator);
  const codexSource = normalizeString(data.codex_source);
  if (cwd) options.cwd = cwd;
  if (host) options.host = host;
  if (platform) options.platform = platform;
  if (model) options.model = model;
  if (codexOriginator) options.codexOriginator = codexOriginator;
  if (codexSource) options.codexSource = codexSource;
  return options;
}

function buildAntigravityPermissionSessionOptions(data) {
  const sourcePid = normalizePositiveInteger(data.source_pid);
  const rawAgentPid = data.agent_pid ?? data.claude_pid ?? data.cursor_pid;
  const agentPid = normalizePositiveInteger(rawAgentPid);
  const pidChain = Array.isArray(data.pid_chain)
    ? data.pid_chain.filter((n) => Number.isFinite(n) && n > 0).map((n) => Math.floor(n))
    : null;
  const options = {
    agentId: "antigravity-cli",
    hookSource: "antigravity-hook",
  };

  if (sourcePid) options.sourcePid = sourcePid;
  if (agentPid) options.agentPid = agentPid;
  if (pidChain && pidChain.length) options.pidChain = pidChain;
  const cwd = normalizeString(data.cwd);
  const host = normalizeString(data.host);
  const platform = normalizeString(data.platform);
  if (cwd) options.cwd = cwd;
  if (host) options.host = host;
  if (platform) options.platform = platform;
  return options;
}

function sendCodexPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendPiPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function sendAntigravityPermissionNoDecision(res) {
  res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
  res.end();
}

function startRemoteApproval(ctx, permEntry) {
  if (permEntry && permEntry.toolName === "ExitPlanMode") return;
  if (typeof ctx.maybeStartRemoteApproval !== "function") return;
  try {
    ctx.maybeStartRemoteApproval(permEntry);
  } catch (err) {
    ctx.permLog(`telegram remote approval start failed: ${err && err.message ? err.message : err}`);
  }
}

function addPendingPermission(ctx, permEntry) {
  if (typeof ctx.addPendingPermission === "function") {
    return ctx.addPendingPermission(permEntry);
  }
  ctx.pendingPermissions.push(permEntry);
  return permEntry;
}

function removePendingPermission(ctx, permEntry, reason) {
  if (typeof ctx.removePendingPermission === "function") {
    return ctx.removePendingPermission(permEntry, reason);
  }
  const idx = ctx.pendingPermissions.indexOf(permEntry);
  if (idx === -1) return false;
  ctx.pendingPermissions.splice(idx, 1);
  return true;
}

function handlePermissionPost(req, res, options) {
  const {
    ctx,
    createRequestHookRecorder,
  } = options;
  ctx.permLog(`/permission hit | DND=${ctx.doNotDisturb} pending=${ctx.pendingPermissions.length}`);
  let body = "";
  let bodySize = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_PERMISSION_BODY_BYTES) { tooLarge = true; return; }
    body += chunk;
  });
  req.on("end", () => {
    if (tooLarge) {
      ctx.permLog("SKIPPED: permission payload too large");
      ctx.sendPermissionResponse(res, "deny", "Permission request too large for Clawd bubble; answer in terminal");
      return;
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    const recordRequestHookEvent = createRequestHookRecorder(data, "permission");

    try {
      // ── opencode branch ──
      // opencode plugin (agents/opencode.js) posts fire-and-forget. We
      // always 200 ACK immediately; the user's decision routes through
      // a separate REST call to opencode's own server (see permission.js
      // replyOpencodePermission). This means no res is retained on the
      // permEntry, no res.on("close") abort handler, and hideBubbles
      // degrades to "TUI only" (plugin doesn't wait on us).
      //
      // DND handling is branch-specific: opencode cannot observe the
      // HTTP response (fire-and-forget), so a generic HTTP deny would
      // leave the TUI hanging until timeout. Instead we route DND
      // through the same reverse bridge the plugin uses for replies.
      if (data.agent_id === "opencode") {
        res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
        res.end("ok");

        // Agent gate: same silent-drop semantics as DND — plugin is
        // fire-and-forget, so 200 ACK satisfies it; skipping the bridge
        // reply lets the opencode TUI fall back to its built-in prompt.
        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("opencode")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog("opencode disabled → silent drop, TUI fallback");
          return;
        }

        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionId = typeof data.session_id === "string" ? data.session_id : "default";
        const requestId = typeof data.request_id === "string" ? data.request_id : null;
        const bridgeUrl = typeof data.bridge_url === "string" ? data.bridge_url : "";
        const bridgeToken = typeof data.bridge_token === "string" ? data.bridge_token : "";
        const alwaysCandidates = Array.isArray(data.always) ? data.always : [];
        const patterns = Array.isArray(data.patterns) ? data.patterns : [];

        ctx.permLog(`opencode perm: tool=${toolName} session=${sessionId} req=${requestId} bridge=${bridgeUrl} always=${alwaysCandidates.length}`);

        // bridge_url/bridge_token are required — this is the reverse
        // channel Clawd uses to send the decision back to the plugin,
        // which then calls opencode's in-process Hono route. Without it
        // we have no way to resolve the pending permission.
        if (!requestId || !bridgeUrl || !bridgeToken) {
          const missing = !requestId ? "request_id" : (!bridgeUrl ? "bridge_url" : "bridge_token");
          recordRequestHookEvent.accepted();
          ctx.permLog(`SKIPPED opencode perm: missing ${missing}`);
          return;
        }

        // DND: drop silently — do NOT reply via bridge. opencode TUI
        // will fall back to its built-in permission prompt so the user
        // can confirm in the terminal themselves. Spike 2026-04-06
        // confirmed this works: TUI shows Allow/Reject without hanging.
        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`opencode DND → silent drop, TUI fallback — request=${requestId}`);
          return;
        }

        // No HTTP connection to hold open — only degradation is to
        // not render a bubble and let the TUI prompt handle it.
        const opencodeSubGateBypass = shouldBypassOpencodeBubble(ctx);
        if (!arePermissionBubblesEnabled(ctx) || opencodeSubGateBypass) {
          recordRequestHookEvent.accepted();
          ctx.permLog(`opencode bubble hidden: tool=${toolName} — TUI fallback (permissionBubblesEnabled=${arePermissionBubblesEnabled(ctx)} subGateBypass=${opencodeSubGateBypass})`);
          return;
        }

        const permEntry = {
          res: null,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          agentId: "opencode",
          isOpencode: true,
          opencodeRequestId: requestId,
          opencodeBridgeUrl: bridgeUrl,
          opencodeBridgeToken: bridgeToken,
          opencodeAlwaysCandidates: alwaysCandidates,
          opencodePatterns: patterns,
        };
        addPendingPermission(ctx, permEntry);
        // Play notification animation on the pet body so the bubble doesn't
        // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
        // and the Elicitation branch below. state.js:581 has a special
        // PermissionRequest branch that setStates notification without
        // mutating session state — so working/thinking is preserved for resolve.
        ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: "opencode" });
        ctx.permLog(`opencode showing bubble: tool=${toolName} session=${sessionId}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          // If bubble creation fails (BrowserWindow error, bad html,
          // window-positioning crash, etc), we have already 200-ACKed
          // the plugin and it is waiting for a bridge reply. Without
          // this rescue the permEntry would linger in pendingPermissions
          // until the opencode TUI hits its own timeout (minutes).
          // Pop the ghost entry and send an immediate reject so the
          // TUI unblocks and the user can re-answer in the terminal.
          ctx.permLog(`opencode bubble failed: ${bubbleErr && bubbleErr.message} — reject via bridge`);
          removePendingPermission(ctx, permEntry, "opencode-bubble-failed");
          ctx.replyOpencodePermission({ bridgeUrl, bridgeToken, requestId, reply: "reject", toolName });
        }
        return;
      }

      // ── Antigravity CLI PreToolUse branch ──
      // Antigravity hooks are blocking and stdout maps directly to
      // {decision:"allow"|"deny"|"ask"}. No-decision here means 204 so the
      // hook prints ask and Antigravity's own approval prompt stays in charge.
      if (data.agent_id === "antigravity-cli") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const antigravityOverrideInput = rawInput.Cwd || !data.cwd
          ? rawInput
          : { ...rawInput, Cwd: data.cwd };
        const antigravityPermissionOverrides = buildAntigravityPermissionOverrides(toolName, antigravityOverrideInput);
        const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "antigravity:default";
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
          ? data.tool_input_fingerprint
          : buildToolInputFingerprint(rawInput);
        const antigravitySessionOptions = buildAntigravityPermissionSessionOptions(data);

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`antigravity DND -> ask fallback (tool=${toolName})`);
          sendAntigravityPermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("antigravity-cli")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`antigravity disabled -> ask fallback (tool=${toolName})`);
          sendAntigravityPermissionNoDecision(res);
          return;
        }

        if (shouldBypassAntigravityBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "antigravity bubbles disabled";
          ctx.permLog(`${reason} -> ask fallback (tool=${toolName})`);
          sendAntigravityPermissionNoDecision(res);
          return;
        }

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          antigravityPermissionOverrides,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          agentId: "antigravity-cli",
          isAntigravity: true,
          sourcePid: antigravitySessionOptions.sourcePid || null,
          cwd: antigravitySessionOptions.cwd || "",
          agentPid: antigravitySessionOptions.agentPid || null,
          pidChain: antigravitySessionOptions.pidChain || null,
          host: antigravitySessionOptions.host || null,
          platform: antigravitySessionOptions.platform || null,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (antigravity)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected");
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        addPendingPermission(ctx, permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", antigravitySessionOptions);

        ctx.permLog(`antigravity showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`antigravity bubble failed: ${bubbleErr && bubbleErr.message} -> ask fallback`);
          removePendingPermission(ctx, permEntry, "antigravity-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendAntigravityPermissionNoDecision(res);
          return;
        }
        startRemoteApproval(ctx, permEntry);
        return;
      }

      // ── Codex official PermissionRequest branch ──
      // The hook is blocking, but fallback must be no-decision rather than
      // Deny: Codex will then continue to its native approval prompt.
      if (data.agent_id === "codex") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "Unknown";
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const description = typeof data.tool_input_description === "string" && data.tool_input_description
          ? data.tool_input_description
          : (typeof rawInput.description === "string" ? rawInput.description : "");
        const toolInput = normalizeCodexPermissionToolInput(rawInput, description);
        const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "codex:default";
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = typeof data.tool_input_fingerprint === "string" && data.tool_input_fingerprint
          ? data.tool_input_fingerprint
          : buildToolInputFingerprint(rawInput);
        const codexSessionOptions = buildCodexPermissionSessionOptions(data);

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`codex DND -> no decision, native prompt fallback (tool=${toolName})`);
          sendCodexPermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("codex")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`codex disabled -> no decision, native prompt fallback (tool=${toolName})`);
          sendCodexPermissionNoDecision(res);
          return;
        }

        if (!shouldInterceptCodexPermission(ctx)) {
          ctx.updateSession(sessionId, "notification", "PermissionRequest", codexSessionOptions);
          ctx.permLog(`codex native permission mode -> no decision, native prompt fallback (tool=${toolName})`);
          recordRequestHookEvent.accepted();
          sendCodexPermissionNoDecision(res);
          return;
        }

        if (shouldBypassCodexBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "codex bubbles disabled";
          ctx.permLog(`${reason} -> no decision, native prompt fallback (tool=${toolName})`);
          sendCodexPermissionNoDecision(res);
          return;
        }

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          agentId: "codex",
          isCodex: true,
          sourcePid: codexSessionOptions.sourcePid || null,
          cwd: codexSessionOptions.cwd || "",
          agentPid: codexSessionOptions.agentPid || null,
          pidChain: codexSessionOptions.pidChain || null,
          host: codexSessionOptions.host || null,
          platform: codexSessionOptions.platform || null,
          model: codexSessionOptions.model || null,
          codexOriginator: codexSessionOptions.codexOriginator || null,
          codexSource: codexSessionOptions.codexSource || null,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (codex)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected");
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        addPendingPermission(ctx, permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", codexSessionOptions);

        ctx.permLog(`codex showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`codex bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          removePendingPermission(ctx, permEntry, "codex-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendCodexPermissionNoDecision(res);
          return;
        }
        startRemoteApproval(ctx, permEntry);
        return;
      }

      // ── Pi extension PermissionRequest branch ──
      // Pi waits synchronously on tool_call handlers but has no native
      // permission prompt. Any Clawd-side no-decision must therefore return
      // promptly so the extension can call ctx.ui.confirm() in the terminal.
      if (data.agent_id === "pi") {
        const toolName = typeof data.tool_name === "string" && data.tool_name ? data.tool_name : "unknown";
        const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
        const toolInput = truncateDeep(rawInput);
        const sessionId = typeof data.session_id === "string" && data.session_id ? data.session_id : "pi:default";
        const toolUseId = normalizeHookToolUseId(
          data.tool_use_id ?? data.toolUseId ?? data.toolUseID
        );
        const toolInputFingerprint = buildToolInputFingerprint(rawInput);

        if (ctx.doNotDisturb) {
          recordRequestHookEvent.droppedByDnd();
          ctx.permLog(`pi DND -> no decision, terminal fallback (tool=${toolName})`);
          sendPiPermissionNoDecision(res);
          return;
        }

        if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("pi")) {
          recordRequestHookEvent.droppedByDisabled();
          ctx.permLog(`pi disabled -> no decision, terminal fallback (tool=${toolName})`);
          sendPiPermissionNoDecision(res);
          return;
        }

        if (shouldBypassPiBubble(ctx)) {
          recordRequestHookEvent.accepted();
          const reason = !arePermissionBubblesEnabled(ctx)
            ? "permission bubbles disabled"
            : "pi bubbles disabled";
          ctx.permLog(`${reason} -> no decision, terminal fallback (tool=${toolName})`);
          sendPiPermissionNoDecision(res);
          return;
        }

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          agentId: "pi",
          isPi: true,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (pi)");
          ctx.resolvePermissionEntry(permEntry, "no-decision", "Client disconnected");
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);

        addPendingPermission(ctx, permEntry);
        ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: "pi" });

        ctx.permLog(`pi showing bubble: tool=${toolName} session=${sessionId} stack=${ctx.pendingPermissions.length}`);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`pi bubble failed: ${bubbleErr && bubbleErr.message} -> no decision`);
          removePendingPermission(ctx, permEntry, "pi-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          sendPiPermissionNoDecision(res);
          return;
        }
        startRemoteApproval(ctx, permEntry);
        return;
      }

      // ── Claude Code branch ──
      // DND: destroy connection — do NOT send deny on the user's behalf.
      // CC falls back to its built-in chat permission prompt so the user
      // decides themselves. Spike 2026-04-07 confirmed: CC shows Allow/
      // Deny in chat, no hang, no timeout. Same pattern as opencode
      // silent drop (95cbfc7).
      if (ctx.doNotDisturb) {
        recordRequestHookEvent.droppedByDnd();
        ctx.permLog("CC DND → destroy connection, CC chat fallback");
        res.destroy();
        return;
      }

      // Agent gate: mirror DND — destroy the connection so CC (or
      // codebuddy, since they share this path) falls back to its built-in
      // chat prompt. Any non-opencode agent_id passing through here
      // gets the same treatment.
      const ccAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
      if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(ccAgentId)) {
        recordRequestHookEvent.droppedByDisabled();
        ctx.permLog(`${ccAgentId} disabled → destroy connection, chat fallback`);
        res.destroy();
        return;
      }

      const toolName = typeof data.tool_name === "string" ? data.tool_name : "Unknown";
      const rawInput = data.tool_input && typeof data.tool_input === "object" ? data.tool_input : {};
      const toolInput = truncateDeep(rawInput);
      const toolUseId = normalizeHookToolUseId(
        data.tool_use_id ?? data.toolUseId ?? data.toolUseID
      );
      const toolInputFingerprint = buildToolInputFingerprint(rawInput);
      const sessionId = data.session_id || "default";
      // Tag the permEntry with the source agent. Clawd's HTTP permission
      // path is shared between Claude Code and codebuddy (both set
      // capabilities.permissionApproval=true and POST here). Stamping lets
      // dismissPermissionsByAgent() clean up the right ones when the user
      // disables an agent mid-flight.
      const permAgentId = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : "claude-code";
      const rawSuggestions = Array.isArray(data.permission_suggestions) ? data.permission_suggestions : [];
      const suggestions = normalizePermissionSuggestions(rawSuggestions);

      const existingSession = ctx.sessions.get(sessionId);
      if (existingSession && existingSession.headless) {
        recordRequestHookEvent.accepted();
        ctx.permLog(`SKIPPED: headless session=${sessionId}`);
        ctx.sendPermissionResponse(res, "deny", "Non-interactive session; auto-denied");
        return;
      }

      if (ctx.PASSTHROUGH_TOOLS.has(toolName)) {
        recordRequestHookEvent.accepted();
        ctx.permLog(`PASSTHROUGH: tool=${toolName} session=${sessionId}`);
        ctx.sendPermissionResponse(res, "allow");
        return;
      }

      if (shouldBypassCCBubble(ctx, toolName, permAgentId)) {
        recordRequestHookEvent.accepted();
        const reason = !arePermissionBubblesEnabled(ctx)
          ? "permission bubbles disabled"
          : `${permAgentId} bubbles disabled`;
        ctx.permLog(`${reason} → destroy connection, chat fallback (tool=${toolName})`);
        res.destroy();
        return;
      }

      // Elicitation (AskUserQuestion) — show notification bubble, not permission bubble.
      // User clicks "Go to Terminal" → deny → Claude Code falls back to terminal.
      if (toolName === "AskUserQuestion") {
        const elicitationInput = normalizeElicitationToolInput(toolInput);
        ctx.permLog(`ELICITATION: tool=${toolName} session=${sessionId}`);
        ctx.updateSession(sessionId, "notification", "Elicitation", { agentId: "claude-code" });

        const permEntry = {
          res,
          abortHandler: null,
          suggestions: [],
          sessionId,
          bubble: null,
          hideTimer: null,
          toolName,
          toolInput: elicitationInput,
          toolUseId,
          toolInputFingerprint,
          resolvedSuggestion: null,
          createdAt: Date.now(),
          isElicitation: true,
          agentId: permAgentId,
        };
        const abortHandler = () => {
          if (res.writableFinished) return;
          ctx.permLog("abortHandler fired (elicitation)");
          ctx.resolvePermissionEntry(permEntry, "deny", "Client disconnected");
        };
        permEntry.abortHandler = abortHandler;
        res.on("close", abortHandler);
        addPendingPermission(ctx, permEntry);
        recordRequestHookEvent.accepted();
        try {
          ctx.showPermissionBubble(permEntry);
        } catch (bubbleErr) {
          ctx.permLog(`elicitation bubble failed: ${bubbleErr && bubbleErr.message} -> terminal fallback`);
          removePendingPermission(ctx, permEntry, "elicitation-bubble-failed");
          if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
          if (permEntry.autoCloseTimer) { clearTimeout(permEntry.autoCloseTimer); permEntry.autoCloseTimer = null; }
          if (permEntry.hideTimer) { clearTimeout(permEntry.hideTimer); permEntry.hideTimer = null; }
          if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
            try { permEntry.bubble.destroy(); } catch {}
          }
          permEntry.bubble = null;
          ctx.sendPermissionResponse(res, "deny", "Elicitation bubble unavailable; answer in terminal", "Elicitation");
        }
        return;
      }

      const permEntry = {
        res,
        abortHandler: null,
        suggestions,
        sessionId,
        bubble: null,
        hideTimer: null,
        toolName,
        toolInput,
        toolUseId,
        toolInputFingerprint,
        resolvedSuggestion: null,
        createdAt: Date.now(),
        agentId: permAgentId,
      };
      const abortHandler = () => {
        if (res.writableFinished) return;
        ctx.permLog("abortHandler fired");
        ctx.resolvePermissionEntry(permEntry, "deny", "Client disconnected");
      };
      permEntry.abortHandler = abortHandler;
      res.on("close", abortHandler);

      addPendingPermission(ctx, permEntry);

      // Play notification animation on the pet body so the bubble doesn't
      // appear "silently". Mirrors the Codex path (main.js showCodexNotifyBubble)
      // and the Elicitation branch above. state.js:581 has a special
      // PermissionRequest branch that setStates notification without
      // mutating session state — so working/thinking is preserved for resolve.
      ctx.updateSession(sessionId, "notification", "PermissionRequest", { agentId: permAgentId });

      ctx.permLog(`showing bubble: tool=${toolName} session=${sessionId} suggestions=${suggestions.length} stack=${ctx.pendingPermissions.length}`);
      recordRequestHookEvent.accepted();
      try {
        ctx.showPermissionBubble(permEntry);
      } catch (bubbleErr) {
        // Mirror the Codex/Pi branches: a BrowserWindow construction failure
        // here would leave a ghost permEntry in pendingPermissions because
        // abortHandler only fires on res close. Pop the entry explicitly and
        // destroy the socket so CC falls back to its built-in chat prompt
        // (non-blocking error per hooks doc) instead of hanging on a stale
        // bubble that was never visible. showPermissionBubble assigns
        // permEntry.bubble before loadFile/showInactive/reposition, so a
        // throw after that point leaves a partially-constructed window —
        // tear it down along with any timers we've armed.
        ctx.permLog(`bubble failed: ${bubbleErr && bubbleErr.message} -> drop connection, chat fallback`);
        removePendingPermission(ctx, permEntry, "bubble-failed");
        if (permEntry.abortHandler) res.removeListener("close", permEntry.abortHandler);
        if (permEntry.autoCloseTimer) { clearTimeout(permEntry.autoCloseTimer); permEntry.autoCloseTimer = null; }
        if (permEntry.hideTimer) { clearTimeout(permEntry.hideTimer); permEntry.hideTimer = null; }
        if (permEntry.bubble && !permEntry.bubble.isDestroyed()) {
          try { permEntry.bubble.destroy(); } catch {}
        }
        permEntry.bubble = null;
        try { res.destroy(); } catch {}
        return;
      }
      startRemoteApproval(ctx, permEntry);
    } catch (err) {
      ctx.permLog(`/permission handler error: ${err && err.message}`);
      // Response may already be sent (opencode branch 200-ACKs before
      // processing), so guard against a second writeHead.
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("internal error");
      }
    }
  });
}

module.exports = {
  MAX_PERMISSION_BODY_BYTES,
  shouldBypassCCBubble,
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
  shouldBypassPiBubble,
  shouldBypassAntigravityBubble,
  arePermissionBubblesEnabled,
  shouldInterceptCodexPermission,
  sendCodexPermissionNoDecision,
  sendPiPermissionNoDecision,
  sendAntigravityPermissionNoDecision,
  buildAntigravityPermissionOverrides,
  handlePermissionPost,
};

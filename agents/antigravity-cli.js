// Antigravity CLI agent configuration
// Hooks via ~/.gemini/config/hooks.json, stdin JSON + stdout JSON

module.exports = {
  id: "antigravity-cli",
  name: "Antigravity CLI",
  processNames: { win: ["agy.exe"], mac: ["agy"], linux: ["agy"] },
  eventSource: "hook",
  // PreToolUse intentionally omitted — agy 1.0.1 owns permission via its native
  // 5-option menu (triggered by the LLM's proactive ask_permission tool calls);
  // Clawd is state-only here. See docs/plans/plan-antigravity-permission-tiers.md.
  eventMap: {
    PreInvocation: "thinking",
    PostToolUse: "working",
    PostInvocation: "idle",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "antigravity-hooks-json",
  },
  stdinFormat: "antigravityHookJson",
  pidField: "agy_pid",
};

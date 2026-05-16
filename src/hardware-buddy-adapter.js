"use strict";

const path = require("path");

function truthy(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function isEnabledFromEnv(env = process.env) {
  if (truthy(env.CLAWD_HARDWARE_BUDDY_DISABLED)) return false;
  if (truthy(env.CLAWD_HARDWARE_BUDDY)) return true;
  if (env.CLAWD_HARDWARE_BUDDY_BACKEND) return true;
  if (env.CLAWD_HARDWARE_BUDDY_ADDRESS) return true;
  return false;
}

function numberFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function defaultCoreRoot(env = process.env) {
  return env.CLAWD_HARDWARE_BUDDY_ROOT
    || path.resolve(__dirname, "..", "..", "ClaudeBuddy");
}

function loadCoreModules(coreRoot) {
  const controllerPath = path.join(coreRoot, "src", "hardware-buddy", "controller.js");
  const sidecarPath = path.join(coreRoot, "src", "hardware-buddy", "sidecar-client.js");
  return {
    HardwareBuddyController: require(controllerPath).HardwareBuddyController,
    SidecarClient: require(sidecarPath).SidecarClient,
  };
}

function defaultSidecarScript(coreRoot, env = process.env) {
  return env.CLAWD_HARDWARE_BUDDY_SIDECAR
    || path.join(coreRoot, "tools", "hardware_buddy_bridge.py");
}

function buildSidecarArgs(options) {
  const {
    env,
    coreRoot,
  } = options;
  const args = [
    defaultSidecarScript(coreRoot, env),
    "--backend",
    env.CLAWD_HARDWARE_BUDDY_BACKEND || "bleak",
  ];
  if (env.CLAWD_HARDWARE_BUDDY_SCAN_TIMEOUT) {
    args.push("--scan-timeout", String(env.CLAWD_HARDWARE_BUDDY_SCAN_TIMEOUT));
  }
  if (env.CLAWD_HARDWARE_BUDDY_CONNECT_TIMEOUT) {
    args.push("--connect-timeout", String(env.CLAWD_HARDWARE_BUDDY_CONNECT_TIMEOUT));
  }
  if (env.CLAWD_HARDWARE_BUDDY_NAME_PREFIX) {
    args.push("--name-prefix", env.CLAWD_HARDWARE_BUDDY_NAME_PREFIX);
  }
  return args;
}

function callSafely(fn, log) {
  try {
    return fn();
  } catch (err) {
    if (typeof log === "function") log(`callback failed: ${err && err.message ? err.message : err}`);
    return undefined;
  }
}

function createHardwareBuddyAdapter(options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === "function" ? options.log : () => {};
  const enabled = options.enabled != null ? !!options.enabled : isEnabledFromEnv(env);
  const permissionsEnabled = options.permissionsEnabled != null
    ? !!options.permissionsEnabled
    : truthy(env.CLAWD_HARDWARE_BUDDY_PERMISSIONS);
  const coreRoot = options.coreRoot || defaultCoreRoot(env);
  const autoConnectAddress = options.autoConnectAddress || env.CLAWD_HARDWARE_BUDDY_ADDRESS || "";
  const keepaliveMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_KEEPALIVE_MS, 10000);
  const autoConnectDelayMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_CONNECT_DELAY_MS, 1000);
  const notifyDebounceMs = options.notifyDebounceMs != null
    ? numberFromEnv(options.notifyDebounceMs, 50)
    : numberFromEnv(env.CLAWD_HARDWARE_BUDDY_NOTIFY_DEBOUNCE_MS, 50);
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;

  let controller = null;
  let sidecar = null;
  let started = false;
  let autoConnectTimer = null;
  let stateNotifyTimer = null;
  let lastStatus = null;
  let lastDevices = [];

  function clearAutoConnectTimer() {
    if (autoConnectTimer) clearTimer(autoConnectTimer);
    autoConnectTimer = null;
  }

  function clearStateNotifyTimer() {
    if (stateNotifyTimer) clearTimer(stateNotifyTimer);
    stateNotifyTimer = null;
  }

  function getPendingPermissions() {
    if (!permissionsEnabled) return [];
    if (typeof options.getPendingPermissions !== "function") return [];
    return callSafely(() => options.getPendingPermissions(), log) || [];
  }

  function emitStateChange() {
    stateNotifyTimer = null;
    if (!started || !controller || typeof controller.notifyStateChanged !== "function") return null;
    return controller.notifyStateChanged();
  }

  function cleanupStartedParts() {
    clearAutoConnectTimer();
    clearStateNotifyTimer();
    if (controller && typeof controller.stop === "function") {
      try {
        controller.stop();
      } catch (err) {
        log(`controller stop failed: ${err && err.message ? err.message : err}`);
      }
    }
    if (sidecar && typeof sidecar.stop === "function") {
      try {
        sidecar.stop();
      } catch (err) {
        log(`sidecar stop failed: ${err && err.message ? err.message : err}`);
      }
    }
    controller = null;
    sidecar = null;
    started = false;
  }

  function start() {
    if (started) return true;
    if (!enabled) {
      return false;
    }

    const modules = options.coreModules || loadCoreModules(coreRoot);
    const HardwareBuddyController = options.HardwareBuddyController || modules.HardwareBuddyController;
    const SidecarClient = options.SidecarClient || modules.SidecarClient;
    if (typeof HardwareBuddyController !== "function" || typeof SidecarClient !== "function") {
      throw new Error("Hardware Buddy core modules are unavailable");
    }
    if (permissionsEnabled && typeof options.resolvePermissionEntry !== "function") {
      log("permissions requested but resolvePermissionEntry is unavailable; hardware permission replies will be ignored");
    }

    sidecar = new SidecarClient({
      command: options.command || env.CLAWD_HARDWARE_BUDDY_PYTHON || "python",
      args: options.args || buildSidecarArgs({ env, coreRoot }),
      log: (level, message, meta) => log(`sidecar ${level}: ${message}`, meta),
      onStatus: (status) => {
        lastStatus = status;
      },
      onDevices: (items) => {
        lastDevices = Array.isArray(items) ? items.slice() : [];
      },
      onError: (err) => log(`sidecar error: ${err && err.message ? err.message : err}`),
      onTransportStateChanged: () => {
        if (controller && typeof controller.notifyStateChanged === "function") {
          controller.notifyStateChanged();
        }
      },
    });

    controller = new HardwareBuddyController({
      transport: sidecar.transport,
      getSessionSnapshot: () => callSafely(options.getSessionSnapshot || (() => ({ sessions: [] })), log) || { sessions: [] },
      getPendingPermissions,
      getDoNotDisturb: () => !!callSafely(options.getDoNotDisturb || (() => false), log),
      isAgentEnabled: options.isAgentEnabled,
      isAgentPermissionsEnabled: options.isAgentPermissionsEnabled,
      resolvePermissionEntry: permissionsEnabled && typeof options.resolvePermissionEntry === "function"
        ? options.resolvePermissionEntry
        : null,
      statePriority: options.statePriority,
      keepaliveMs,
      log: (message) => log(`controller: ${message}`),
    });

    try {
      sidecar.start();
      controller.start();
      started = true;
    } catch (err) {
      cleanupStartedParts();
      throw err;
    }
    log(`started backend=${env.CLAWD_HARDWARE_BUDDY_BACKEND || "bleak"} permissions=${permissionsEnabled ? "on" : "off"}`);

    if (autoConnectAddress) {
      autoConnectTimer = setTimer(() => {
        if (!started || !sidecar) return;
        sidecar.connect(autoConnectAddress);
      }, autoConnectDelayMs);
    }
    return true;
  }

  function stop() {
    cleanupStartedParts();
  }

  function notifyStateChanged() {
    if (!started || !controller || typeof controller.notifyStateChanged !== "function") return null;
    if (notifyDebounceMs <= 0) return emitStateChange();
    if (stateNotifyTimer) return true;
    stateNotifyTimer = setTimer(() => {
      emitStateChange();
    }, notifyDebounceMs);
    return true;
  }

  function notifyPermissionsChanged() {
    if (!started || !controller || typeof controller.notifyPermissionsChanged !== "function") return null;
    return controller.notifyPermissionsChanged();
  }

  return {
    start,
    stop,
    notifyStateChanged,
    notifyPermissionsChanged,
    isEnabled: () => enabled,
    isStarted: () => started,
    getLastStatus: () => lastStatus,
    getLastDevices: () => lastDevices.slice(),
    getController: () => controller,
    getSidecar: () => sidecar,
  };
}

module.exports = {
  createHardwareBuddyAdapter,
  isEnabledFromEnv,
};

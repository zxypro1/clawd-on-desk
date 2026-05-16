"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createHardwareBuddyAdapter,
  isEnabledFromEnv,
} = require("../src/hardware-buddy-adapter");

class FakeSidecarClient {
  constructor(options) {
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.connects = [];
    this.sent = [];
    this.transport = {
      secure: false,
      send: (snapshot, meta) => this.sent.push({ snapshot, meta }),
      onCommand: () => () => {},
      isSecure: () => this.transport.secure === true,
    };
    FakeSidecarClient.instances.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }

  connect(address) {
    this.connects.push(address);
    return true;
  }
}
FakeSidecarClient.instances = [];

class ThrowingSidecarClient extends FakeSidecarClient {
  start() {
    this.started = true;
    throw new Error("spawn failed");
  }
}

class FakeHardwareBuddyController {
  constructor(options) {
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.stateChanges = 0;
    this.permissionChanges = 0;
    FakeHardwareBuddyController.instances.push(this);
  }

  start() {
    this.started = true;
    return this.options.getSessionSnapshot();
  }

  stop() {
    this.stopped = true;
  }

  notifyStateChanged() {
    this.stateChanges += 1;
    return this.options.getSessionSnapshot();
  }

  notifyPermissionsChanged() {
    this.permissionChanges += 1;
    return this.options.getPendingPermissions();
  }
}
FakeHardwareBuddyController.instances = [];

function resetFakes() {
  FakeSidecarClient.instances.length = 0;
  FakeHardwareBuddyController.instances.length = 0;
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
}

describe("hardware buddy adapter", () => {
  it("is disabled unless explicitly requested by env", () => {
    assert.strictEqual(isEnabledFromEnv({}), false);
    assert.strictEqual(isEnabledFromEnv({ CLAWD_HARDWARE_BUDDY: "1" }), true);
    assert.strictEqual(isEnabledFromEnv({ CLAWD_HARDWARE_BUDDY_BACKEND: "bleak" }), true);
    assert.strictEqual(isEnabledFromEnv({ CLAWD_HARDWARE_BUDDY_ADDRESS: "AA:BB" }), true);
    assert.strictEqual(isEnabledFromEnv({
      CLAWD_HARDWARE_BUDDY: "1",
      CLAWD_HARDWARE_BUDDY_DISABLED: "true",
    }), false);
  });

  it("does not load or start core modules when disabled", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: {},
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    assert.strictEqual(adapter.start(), false);
    assert.strictEqual(FakeSidecarClient.instances.length, 0);
    assert.strictEqual(FakeHardwareBuddyController.instances.length, 0);
  });

  it("starts state-only controller and suppresses pending permissions by default", () => {
    resetFakes();
    const perm = { toolName: "Bash" };
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1", CLAWD_HARDWARE_BUDDY_BACKEND: "fake" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      notifyDebounceMs: 0,
      getSessionSnapshot: () => ({ sessions: [{ id: "s1", state: "working" }] }),
      getPendingPermissions: () => [perm],
      getDoNotDisturb: () => false,
    });

    assert.strictEqual(adapter.start(), true);
    const sidecar = FakeSidecarClient.instances[0];
    const controller = FakeHardwareBuddyController.instances[0];

    assert.strictEqual(sidecar.started, true);
    assert.strictEqual(controller.started, true);
    assert.deepStrictEqual(controller.options.getPendingPermissions(), []);
    assert.deepStrictEqual(adapter.notifyStateChanged(), {
      sessions: [{ id: "s1", state: "working" }],
    });

    adapter.stop();
    assert.strictEqual(controller.stopped, true);
    assert.strictEqual(sidecar.stopped, true);
  });

  it("can opt into permission entries for a later secure phase", () => {
    resetFakes();
    const perm = { toolName: "Bash" };
    const resolvePermissionEntry = () => {};
    const statePriority = { working: 3 };
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      permissionsEnabled: true,
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      getPendingPermissions: () => [perm],
      resolvePermissionEntry,
      statePriority,
    });

    adapter.start();
    const controller = FakeHardwareBuddyController.instances[0];
    assert.deepStrictEqual(controller.options.getPendingPermissions(), [perm]);
    assert.strictEqual(controller.options.resolvePermissionEntry, resolvePermissionEntry);
    assert.strictEqual(controller.options.statePriority, statePriority);
  });

  it("logs when permission mode is enabled without a resolver", () => {
    resetFakes();
    const logs = [];
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      permissionsEnabled: true,
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      log: (message) => logs.push(message),
    });

    adapter.start();
    assert.match(logs.join("\n"), /resolvePermissionEntry is unavailable/);
    assert.strictEqual(FakeHardwareBuddyController.instances[0].options.resolvePermissionEntry, null);
  });

  it("debounces repeated state-change notifications", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
      getSessionSnapshot: () => ({ sessions: [{ id: "s1", state: "working" }] }),
    });

    adapter.start();
    const controller = FakeHardwareBuddyController.instances[0];
    assert.strictEqual(adapter.notifyStateChanged(), true);
    assert.strictEqual(adapter.notifyStateChanged(), true);
    assert.strictEqual(controller.stateChanges, 0);
    assert.strictEqual(fakeTimers.timers.length, 1);
    assert.strictEqual(fakeTimers.timers[0].ms, 50);

    fakeTimers.timers[0].fn();
    assert.strictEqual(controller.stateChanges, 1);
  });

  it("clears pending state notifications on stop", () => {
    resetFakes();
    const fakeTimers = createFakeTimers();
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
    });

    adapter.start();
    adapter.notifyStateChanged();
    adapter.stop();

    assert.strictEqual(fakeTimers.timers[0].cleared, true);
    assert.strictEqual(adapter.notifyStateChanged(), null);
  });

  it("keeps start idempotent", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    assert.strictEqual(adapter.start(), true);
    assert.strictEqual(adapter.start(), true);
    assert.strictEqual(FakeSidecarClient.instances.length, 1);
    assert.strictEqual(FakeHardwareBuddyController.instances.length, 1);
  });

  it("cleans up partial startup state when sidecar start throws", () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: { CLAWD_HARDWARE_BUDDY: "1" },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: ThrowingSidecarClient,
      },
    });

    assert.throws(() => adapter.start(), /spawn failed/);
    assert.strictEqual(adapter.isStarted(), false);
    assert.strictEqual(adapter.getSidecar(), null);
    assert.strictEqual(adapter.getController(), null);
    assert.strictEqual(FakeSidecarClient.instances[0].stopped, true);
    assert.strictEqual(FakeHardwareBuddyController.instances[0].stopped, true);
  });

  it("auto-connects when an address is configured", async () => {
    resetFakes();
    const adapter = createHardwareBuddyAdapter({
      env: {
        CLAWD_HARDWARE_BUDDY: "1",
        CLAWD_HARDWARE_BUDDY_BACKEND: "fake",
        CLAWD_HARDWARE_BUDDY_ADDRESS: "FAKE:CLAWSTICK",
        CLAWD_HARDWARE_BUDDY_CONNECT_DELAY_MS: "0",
      },
      coreModules: {
        HardwareBuddyController: FakeHardwareBuddyController,
        SidecarClient: FakeSidecarClient,
      },
    });

    adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(FakeSidecarClient.instances[0].connects, ["FAKE:CLAWSTICK"]);
  });
});

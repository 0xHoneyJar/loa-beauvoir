import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { BeauvoirLogger } from "../../safety/logger.js";
import { ResilientJsonStore, ResilientStoreFactory, type StoreConfig } from "../resilient-store.js";

// ── Test Helpers ────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resilient-store-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface TestState {
  name: string;
  count: number;
}

const noopLogger: BeauvoirLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeConfig(overrides?: Partial<StoreConfig<TestState>>): StoreConfig<TestState> {
  return {
    path: path.join(tmpDir, "store.json"),
    schemaVersion: 1,
    logger: noopLogger,
    ...overrides,
  };
}

function makeStore(overrides?: Partial<StoreConfig<TestState>>): ResilientJsonStore<TestState> {
  return new ResilientJsonStore<TestState>(makeConfig(overrides));
}

// ── TASK-2.1: Write Protocol ────────────────────────────────

describe("Write Protocol (TASK-2.1)", () => {
  it("write roundtrip: set then get returns same state", async () => {
    const store = makeStore();
    await store.set({ name: "hello", count: 42 });

    const result = await store.get();
    expect(result).toEqual({ name: "hello", count: 42 });
  });

  it("writes include _schemaVersion and _writeEpoch", async () => {
    const store = makeStore();
    await store.set({ name: "test", count: 1 });

    const raw = fs.readFileSync(path.join(tmpDir, "store.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed._schemaVersion).toBe(1);
    expect(parsed._writeEpoch).toBe(1);
  });

  it("_writeEpoch increments on each write", async () => {
    const store = makeStore();
    await store.set({ name: "a", count: 1 });
    await store.set({ name: "b", count: 2 });
    await store.set({ name: "c", count: 3 });

    const raw = fs.readFileSync(path.join(tmpDir, "store.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed._writeEpoch).toBe(3);
  });

  it("rejects writes exceeding maxSizeBytes", async () => {
    const store = makeStore({ maxSizeBytes: 50 });
    await expect(store.set({ name: "x".repeat(100), count: 1 })).rejects.toThrow(/exceeds maximum/);

    // Ensure no file was written
    expect(fs.existsSync(path.join(tmpDir, "store.json"))).toBe(false);
  });

  it("produces sorted JSON output", async () => {
    const store = makeStore();
    await store.set({ name: "test", count: 5 });

    const raw = fs.readFileSync(path.join(tmpDir, "store.json"), "utf8");
    const keys = Object.keys(JSON.parse(raw));
    // Sorted: _schemaVersion, _writeEpoch, count, name
    expect(keys).toEqual(["_schemaVersion", "_writeEpoch", "count", "name"]);
  });

  it("creates .bak on second write", async () => {
    const store = makeStore();
    await store.set({ name: "first", count: 1 });
    await store.set({ name: "second", count: 2 });

    const bakPath = path.join(tmpDir, "store.json.bak");
    expect(fs.existsSync(bakPath)).toBe(true);

    const bakData = JSON.parse(fs.readFileSync(bakPath, "utf8"));
    expect(bakData.name).toBe("first");
    expect(bakData._writeEpoch).toBe(1);
  });

  it("tmp file is cleaned up after successful write", async () => {
    const store = makeStore();
    await store.set({ name: "test", count: 1 });

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("exists() returns true after write, false before", async () => {
    const store = makeStore();
    expect(await store.exists()).toBe(false);
    await store.set({ name: "test", count: 1 });
    expect(await store.exists()).toBe(true);
  });

  it("clear() removes primary, bak, and tmp files", async () => {
    const store = makeStore();
    await store.set({ name: "a", count: 1 });
    await store.set({ name: "b", count: 2 });

    await store.clear();

    expect(fs.existsSync(path.join(tmpDir, "store.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "store.json.bak"))).toBe(false);
    expect(await store.get()).toBeNull();
  });
});

// ── TASK-2.2: Read Fallback + Tmp Lifecycle ─────────────────

describe("Read Fallback Chain (TASK-2.2)", () => {
  it("reads from primary when it exists", async () => {
    const store = makeStore();
    await store.set({ name: "primary", count: 1 });

    const result = await store.get();
    expect(result).toEqual({ name: "primary", count: 1 });
  });

  it("falls back to .bak when primary is corrupt", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore();
    await store.set({ name: "first", count: 1 });
    await store.set({ name: "second", count: 2 });

    // Corrupt the primary
    fs.writeFileSync(storePath, "{{not json}}");

    const result = await store.get();
    expect(result).toEqual({ name: "first", count: 1 });
  });

  it("falls back to .bak when primary is missing", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore();
    await store.set({ name: "first", count: 1 });
    await store.set({ name: "second", count: 2 });

    // Remove primary
    fs.unlinkSync(storePath);

    const result = await store.get();
    expect(result).toEqual({ name: "first", count: 1 });
  });

  it("returns null when all sources are corrupt", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore();
    await store.set({ name: "data", count: 1 });

    // Corrupt primary and bak
    fs.writeFileSync(storePath, "bad");
    fs.writeFileSync(`${storePath}.bak`, "also bad");

    const result = await store.get();
    expect(result).toBeNull();
  });

  it("accepts tmp with higher epoch than primary", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore();
    await store.set({ name: "primary", count: 1 });

    // Simulate a tmp file left behind from a crash with higher epoch
    const tmpContent = JSON.stringify({
      _schemaVersion: 1,
      _writeEpoch: 99,
      name: "recovered",
      count: 99,
    });
    fs.writeFileSync(`${storePath}.12345.tmp`, tmpContent);

    // Corrupt primary so fallback chain reaches tmp
    fs.writeFileSync(storePath, "corrupt");
    // Also remove bak
    try {
      fs.unlinkSync(`${storePath}.bak`);
    } catch {
      // May not exist
    }

    const result = await store.get();
    expect(result).toEqual({ name: "recovered", count: 99 });
  });

  it("rejects tmp with lower epoch than primary", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore();
    await store.set({ name: "first", count: 1 });
    await store.set({ name: "second", count: 2 });
    await store.set({ name: "third", count: 3 });

    // Place a tmp with epoch 1 (lower than primary's 3)
    const tmpContent = JSON.stringify({
      _schemaVersion: 1,
      _writeEpoch: 1,
      name: "stale-tmp",
      count: 0,
    });
    fs.writeFileSync(`${storePath}.99999.tmp`, tmpContent);

    const result = await store.get();
    // Should use primary, not the stale tmp
    expect(result).toEqual({ name: "third", count: 3 });
  });

  it("picks highest epoch among multiple tmp files", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore();

    // No primary or bak — only tmp files
    const tmps = [
      { pid: 100, epoch: 5, name: "tmp-5" },
      { pid: 200, epoch: 10, name: "tmp-10" },
      { pid: 300, epoch: 7, name: "tmp-7" },
    ];

    for (const t of tmps) {
      fs.writeFileSync(
        `${storePath}.${t.pid}.tmp`,
        JSON.stringify({
          _schemaVersion: 1,
          _writeEpoch: t.epoch,
          name: t.name,
          count: t.epoch,
        }),
      );
    }

    const result = await store.get();
    expect(result).toEqual({ name: "tmp-10", count: 10 });
  });

  it("cleans up stale tmp files after successful read", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore();
    await store.set({ name: "primary", count: 1 });

    // Place stale tmp files
    fs.writeFileSync(
      `${storePath}.11111.tmp`,
      JSON.stringify({ _schemaVersion: 1, _writeEpoch: 0, name: "stale", count: 0 }),
    );

    await store.get();

    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ── TASK-2.3: Schema Migrations ─────────────────────────────

describe("Schema Migrations (TASK-2.3)", () => {
  interface V2State {
    name: string;
    count: number;
    label: string;
  }

  it("migrates v1 to v2 on read", async () => {
    const storePath = path.join(tmpDir, "store.json");

    // Write a v1 file manually
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        _schemaVersion: 1,
        _writeEpoch: 1,
        name: "old",
        count: 5,
      }),
    );

    const store = new ResilientJsonStore<V2State>({
      path: storePath,
      schemaVersion: 2,
      migrations: {
        2: (data: unknown) => {
          const d = data as Record<string, unknown>;
          return { ...d, label: "migrated" };
        },
      },
      logger: noopLogger,
    });

    const result = await store.get();
    expect(result).toEqual({ name: "old", count: 5, label: "migrated" });

    // Verify the file was rewritten at v2
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    expect(raw._schemaVersion).toBe(2);
  });

  it("chains migrations v1 -> v2 -> v3", async () => {
    const storePath = path.join(tmpDir, "store.json");

    fs.writeFileSync(
      storePath,
      JSON.stringify({
        _schemaVersion: 1,
        _writeEpoch: 1,
        name: "original",
        count: 1,
      }),
    );

    interface V3State {
      name: string;
      count: number;
      label: string;
      tags: string[];
    }

    const store = new ResilientJsonStore<V3State>({
      path: storePath,
      schemaVersion: 3,
      migrations: {
        2: (data: unknown) => {
          const d = data as Record<string, unknown>;
          return { ...d, label: "v2" };
        },
        3: (data: unknown) => {
          const d = data as Record<string, unknown>;
          return { ...d, tags: ["auto"] };
        },
      },
      logger: noopLogger,
    });

    const result = await store.get();
    expect(result).toEqual({
      name: "original",
      count: 1,
      label: "v2",
      tags: ["auto"],
    });
  });

  it("throws on missing migration step", async () => {
    const storePath = path.join(tmpDir, "store.json");

    fs.writeFileSync(
      storePath,
      JSON.stringify({
        _schemaVersion: 1,
        _writeEpoch: 1,
        name: "old",
        count: 1,
      }),
    );

    const store = new ResilientJsonStore<TestState>({
      path: storePath,
      schemaVersion: 3,
      migrations: {
        // Missing migration for v2
        3: (data: unknown) => data,
      },
      logger: noopLogger,
    });

    await expect(store.get()).rejects.toThrow(/Missing migration from version 1 to 2/);
  });
});

// ── TASK-2.4: Quarantine Management ─────────────────────────

describe("Quarantine Management (TASK-2.4)", () => {
  it("quarantines corrupt files when all sources fail", async () => {
    const storePath = path.join(tmpDir, "store.json");
    let nowMs = 1000000;

    const store = makeStore({ now: () => nowMs });

    // Write a valid file, then corrupt everything
    fs.writeFileSync(storePath, "corrupt primary");
    fs.writeFileSync(`${storePath}.bak`, "corrupt bak");

    const result = await store.get();
    expect(result).toBeNull();

    // Check quarantine files exist
    const files = fs.readdirSync(tmpDir);
    const quarantineFiles = files.filter((f) => f.includes(".quarantine."));
    expect(quarantineFiles.length).toBeGreaterThan(0);
  });

  it("cleanupQuarantine deletes files older than 7 days", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    let nowMs = Date.now();

    const store = makeStore({ now: () => nowMs });

    // Create quarantine files with old timestamps
    const oldQuarantine = `${storePath}.quarantine.old`;
    fs.writeFileSync(oldQuarantine, "old data");
    // Set mtime to 8 days ago
    const eightDaysAgo = new Date(nowMs - sevenDaysMs - 86400000);
    fs.utimesSync(oldQuarantine, eightDaysAgo, eightDaysAgo);

    // Create a recent quarantine file
    const recentQuarantine = `${storePath}.quarantine.recent`;
    fs.writeFileSync(recentQuarantine, "recent data");

    const deleted = await store.cleanupQuarantine();
    expect(deleted).toBe(1);

    // Old one should be gone, recent one should remain
    expect(fs.existsSync(oldQuarantine)).toBe(false);
    expect(fs.existsSync(recentQuarantine)).toBe(true);
  });

  it("cleanupQuarantine retains files newer than 7 days", async () => {
    const storePath = path.join(tmpDir, "store.json");
    const store = makeStore({ now: () => Date.now() });

    // Create a recent quarantine file
    const recentQuarantine = `${storePath}.quarantine.123`;
    fs.writeFileSync(recentQuarantine, "data");

    const deleted = await store.cleanupQuarantine();
    expect(deleted).toBe(0);
    expect(fs.existsSync(recentQuarantine)).toBe(true);
  });
});

// ── TASK-2.5: ResilientStoreFactory ─────────────────────────

describe("ResilientStoreFactory (TASK-2.5)", () => {
  it("creates stores at {baseDir}/{name}.json", async () => {
    const factory = new ResilientStoreFactory({
      baseDir: tmpDir,
      logger: noopLogger,
    });

    const store = factory.create<TestState>("mystore", {
      schemaVersion: 1,
    });

    await store.set({ name: "factory-test", count: 7 });

    const expectedPath = path.join(tmpDir, "mystore.json");
    expect(fs.existsSync(expectedPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
    expect(data.name).toBe("factory-test");
  });

  it("all factory stores share the same logger", async () => {
    const logs: string[] = [];
    const trackingLogger: BeauvoirLogger = {
      debug: (msg) => logs.push(`debug:${msg}`),
      info: (msg) => logs.push(`info:${msg}`),
      warn: (msg) => logs.push(`warn:${msg}`),
      error: (msg) => logs.push(`error:${msg}`),
    };

    const factory = new ResilientStoreFactory({
      baseDir: tmpDir,
      logger: trackingLogger,
    });

    const storeA = factory.create<TestState>("a", { schemaVersion: 1 });
    const storeB = factory.create<TestState>("b", { schemaVersion: 1 });

    await storeA.set({ name: "a", count: 1 });
    await storeB.set({ name: "b", count: 2 });

    await storeA.get();
    await storeB.get();

    // Both stores should have produced log output via the same logger
    expect(logs.length).toBeGreaterThan(0);
  });

  it("factory creates multiple independent stores", async () => {
    const factory = new ResilientStoreFactory({
      baseDir: tmpDir,
      logger: noopLogger,
    });

    const store1 = factory.create<TestState>("store1", { schemaVersion: 1 });
    const store2 = factory.create<TestState>("store2", { schemaVersion: 1 });

    await store1.set({ name: "one", count: 1 });
    await store2.set({ name: "two", count: 2 });

    expect(await store1.get()).toEqual({ name: "one", count: 1 });
    expect(await store2.get()).toEqual({ name: "two", count: 2 });
  });
});

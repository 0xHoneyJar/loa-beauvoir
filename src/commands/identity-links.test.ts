import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

import {
  identityLinksAddCommand,
  identityLinksListCommand,
  identityLinksRemoveCommand,
  identityLinksResolveCommand,
  isValidProviderIdFormat,
} from "./identity-links.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const baseSnapshot = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

beforeEach(() => {
  configMocks.readConfigFileSnapshot.mockReset();
  configMocks.writeConfigFile.mockClear();
  (runtime.log as ReturnType<typeof vi.fn>).mockClear();
  (runtime.error as ReturnType<typeof vi.fn>).mockClear();
  (runtime.exit as ReturnType<typeof vi.fn>).mockClear();
});

// ---------------------------------------------------------------------------
// isValidProviderIdFormat
// ---------------------------------------------------------------------------

describe("isValidProviderIdFormat", () => {
  it("accepts valid provider:id formats", () => {
    expect(isValidProviderIdFormat("telegram:123456")).toBe(true);
    expect(isValidProviderIdFormat("discord:abc-def")).toBe(true);
    expect(isValidProviderIdFormat("slack:U12345")).toBe(true);
    expect(isValidProviderIdFormat("matrix:@user:server.com")).toBe(true);
    expect(isValidProviderIdFormat("my-provider:some_id")).toBe(true);
  });

  it("rejects invalid formats", () => {
    expect(isValidProviderIdFormat("nocolon")).toBe(false);
    expect(isValidProviderIdFormat("")).toBe(false);
    expect(isValidProviderIdFormat(":empty-provider")).toBe(false);
    expect(isValidProviderIdFormat("has space:id")).toBe(false);
  });

  it("rejects provider with empty id part", () => {
    expect(isValidProviderIdFormat("telegram:")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

describe("identityLinksListCommand", () => {
  it("shows empty message when no links configured", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {},
    });

    await identityLinksListCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith("No identity links configured.");
  });

  it("lists links in table format", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          identityLinks: {
            alice: ["telegram:123", "discord:456"],
            bob: ["slack:789"],
          },
        },
      },
    });

    await identityLinksListCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith("alice");
    expect(runtime.log).toHaveBeenCalledWith("  telegram:123");
    expect(runtime.log).toHaveBeenCalledWith("  discord:456");
    expect(runtime.log).toHaveBeenCalledWith("bob");
    expect(runtime.log).toHaveBeenCalledWith("  slack:789");
  });

  it("outputs JSON when --json specified", async () => {
    const links = { alice: ["telegram:123"] };
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: { session: { identityLinks: links } },
    });

    await identityLinksListCommand({ json: true }, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.parse(output as string)).toEqual(links);
  });
});

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

describe("identityLinksAddCommand", () => {
  it("adds a new canonical with provider ID", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {},
    });

    await identityLinksAddCommand("alice", "telegram:123", {}, runtime);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      session?: { identityLinks?: Record<string, string[]> };
    };
    expect(written.session?.identityLinks).toEqual({
      alice: ["telegram:123"],
    });
  });

  it("appends to existing canonical entry", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: { identityLinks: { alice: ["telegram:123"] } },
      },
    });

    await identityLinksAddCommand("alice", "discord:456", {}, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      session?: { identityLinks?: Record<string, string[]> };
    };
    expect(written.session?.identityLinks?.alice).toEqual(["telegram:123", "discord:456"]);
  });

  it("detects case-insensitive duplicates", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: { identityLinks: { alice: ["Telegram:123"] } },
      },
    });

    await identityLinksAddCommand("alice", "telegram:123", {}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("already linked"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("rejects invalid provider ID format", async () => {
    await identityLinksAddCommand("alice", "nocolon", {}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Invalid provider ID format"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects empty canonical name", async () => {
    await identityLinksAddCommand("  ", "telegram:123", {}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("must not be empty"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("outputs JSON when --json specified", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {},
    });

    await identityLinksAddCommand("alice", "telegram:123", { json: true }, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(output).toBeDefined();
    expect(JSON.parse(output![0] as string)).toEqual({
      canonical: "alice",
      providerId: "telegram:123",
      action: "added",
    });
  });
});

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

describe("identityLinksRemoveCommand", () => {
  it("removes a single provider ID", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          identityLinks: { alice: ["telegram:123", "discord:456"] },
        },
      },
    });

    await identityLinksRemoveCommand("alice", "telegram:123", {}, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      session?: { identityLinks?: Record<string, string[]> };
    };
    expect(written.session?.identityLinks?.alice).toEqual(["discord:456"]);
  });

  it("removes entry when last ID removed", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          identityLinks: { alice: ["telegram:123"] },
          dmScope: "per-peer",
        },
      },
    });

    await identityLinksRemoveCommand("alice", "telegram:123", {}, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      session?: { identityLinks?: Record<string, string[]> };
    };
    expect(written.session?.identityLinks).toBeUndefined();
    // dmScope should still be present
    expect(written.session?.dmScope).toBe("per-peer");
  });

  it("removes entire canonical entry when no providerId given", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          identityLinks: {
            alice: ["telegram:123", "discord:456"],
            bob: ["slack:789"],
          },
        },
      },
    });

    await identityLinksRemoveCommand("alice", undefined, {}, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      session?: { identityLinks?: Record<string, string[]> };
    };
    expect(written.session?.identityLinks).toEqual({ bob: ["slack:789"] });
  });

  it("errors when canonical not found", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: { identityLinks: { alice: ["telegram:123"] } },
      },
    });

    await identityLinksRemoveCommand("bob", "telegram:123", {}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('No identity link found for "bob"'),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when provider ID not found under canonical", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: { identityLinks: { alice: ["telegram:123"] } },
      },
    });

    await identityLinksRemoveCommand("alice", "discord:999", {}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('"discord:999" not found under "alice"'),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("case-insensitive removal", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          identityLinks: { alice: ["Telegram:123", "discord:456"] },
        },
      },
    });

    await identityLinksRemoveCommand("alice", "telegram:123", {}, runtime);

    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      session?: { identityLinks?: Record<string, string[]> };
    };
    expect(written.session?.identityLinks?.alice).toEqual(["discord:456"]);
  });

  it("outputs JSON when --json specified", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: { identityLinks: { alice: ["telegram:123"] } },
      },
    });

    await identityLinksRemoveCommand("alice", "telegram:123", { json: true }, runtime);

    const jsonCalls = (runtime.log as ReturnType<typeof vi.fn>).mock.calls.filter((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonCalls.length).toBeGreaterThan(0);
    expect(JSON.parse(jsonCalls[0]![0] as string)).toEqual({
      canonical: "alice",
      providerId: "telegram:123",
      action: "removed",
    });
  });
});

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

describe("identityLinksResolveCommand", () => {
  it("resolves a linked identity", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          dmScope: "per-peer",
          identityLinks: { alice: ["telegram:123"] },
        },
      },
    });

    await identityLinksResolveCommand("telegram", "123", {}, runtime);

    expect(runtime.log).toHaveBeenCalledWith("Canonical:  alice");
  });

  it("shows no match when identity not linked", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          dmScope: "per-peer",
          identityLinks: { alice: ["telegram:123"] },
        },
      },
    });

    await identityLinksResolveCommand("discord", "999", {}, runtime);

    expect(runtime.log).toHaveBeenCalledWith("Canonical:  (none — no match)");
  });

  it("uses dmScope override", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          identityLinks: { alice: ["telegram:123"] },
        },
      },
    });

    await identityLinksResolveCommand("telegram", "123", { dmScope: "per-peer" }, runtime);

    expect(runtime.log).toHaveBeenCalledWith("DM Scope:   per-peer");
    expect(runtime.log).toHaveBeenCalledWith("Canonical:  alice");
  });

  it("outputs JSON when --json specified", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        session: {
          dmScope: "per-peer",
          identityLinks: { alice: ["telegram:123"] },
        },
      },
    });

    await identityLinksResolveCommand("telegram", "123", { json: true }, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output as string);
    expect(parsed.channel).toBe("telegram");
    expect(parsed.peerId).toBe("123");
    expect(parsed.resolvedCanonical).toBe("alice");
    expect(parsed.sessionKey).toBeDefined();
  });

  it("resolves without identity links configured", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {},
    });

    await identityLinksResolveCommand("telegram", "123", { dmScope: "per-peer" }, runtime);

    expect(runtime.log).toHaveBeenCalledWith("Canonical:  (none — no match)");
  });
});

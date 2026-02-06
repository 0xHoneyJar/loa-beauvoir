import type { RuntimeEnv } from "../runtime.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { buildAgentPeerSessionKey, resolveLinkedPeerId } from "../routing/session-key.js";
import { requireValidConfig } from "./agents.command-shared.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PROVIDER_ID_RE = /^[a-zA-Z0-9_-]+:.+$/;
const CANONICAL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VALID_DM_SCOPES = new Set([
  "main",
  "per-peer",
  "per-channel-peer",
  "per-account-channel-peer",
]);

/** Validate `provider:id` format (e.g. `telegram:123456`, `discord:abc`). */
export function isValidProviderIdFormat(value: string): boolean {
  return PROVIDER_ID_RE.test(value);
}

/** Validate canonical identity name (alphanumeric, hyphens, underscores, 1-64 chars). */
export function isValidCanonicalName(value: string): boolean {
  return CANONICAL_NAME_RE.test(value);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type IdentityLinksListOpts = {
  json?: boolean;
};

export async function identityLinksListCommand(
  opts: IdentityLinksListOpts,
  runtime: RuntimeEnv,
): Promise<void> {
  const config = await requireValidConfig(runtime);
  if (!config) return;

  const links: Record<string, string[]> = config.session?.identityLinks ?? {};

  if (opts.json) {
    runtime.log(JSON.stringify(links, null, 2));
    return;
  }

  const entries = Object.entries(links);
  if (entries.length === 0) {
    runtime.log("No identity links configured.");
    return;
  }

  for (const [canonical, ids] of entries) {
    runtime.log(`${canonical}`);
    for (const id of ids) {
      runtime.log(`  ${id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

export type IdentityLinksAddOpts = {
  json?: boolean;
};

export async function identityLinksAddCommand(
  canonical: string,
  providerId: string,
  opts: IdentityLinksAddOpts,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!canonical.trim()) {
    runtime.error("Canonical name must not be empty.");
    runtime.exit(1);
    return;
  }

  if (!isValidCanonicalName(canonical)) {
    runtime.error(
      `Invalid canonical name: "${canonical}". Must be 1-64 alphanumeric characters, hyphens, or underscores.`,
    );
    runtime.exit(1);
    return;
  }

  if (!isValidProviderIdFormat(providerId)) {
    runtime.error(
      `Invalid provider ID format: "${providerId}". Expected provider:id (e.g. telegram:123456).`,
    );
    runtime.exit(1);
    return;
  }

  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    runtime.error("Config invalid. Run openclaw doctor.");
    runtime.exit(1);
    return;
  }

  const config = snapshot.config ?? {};
  const links: Record<string, string[]> = { ...(config.session?.identityLinks ?? {}) };
  const existing = links[canonical] ?? [];

  // Case-insensitive duplicate check (same canonical)
  const normalizedNew = providerId.toLowerCase();
  if (existing.some((id) => id.toLowerCase() === normalizedNew)) {
    runtime.error(`"${providerId}" already linked to "${canonical}".`);
    runtime.exit(1);
    return;
  }

  // Cross-canonical duplicate check: provider ID must not exist under any other canonical
  for (const [otherCanonical, otherIds] of Object.entries(links)) {
    if (otherCanonical === canonical) continue;
    if (otherIds.some((id) => id.toLowerCase() === normalizedNew)) {
      runtime.error(
        `"${providerId}" is already linked to "${otherCanonical}". Remove it first before linking to "${canonical}".`,
      );
      runtime.exit(1);
      return;
    }
  }

  links[canonical] = [...existing, providerId];

  const updated = {
    ...config,
    session: {
      ...config.session,
      identityLinks: links,
    },
  };

  await writeConfigFile(updated);
  logConfigUpdated(runtime, { suffix: `(identity-links: added ${providerId} → ${canonical})` });

  if (opts.json) {
    runtime.log(JSON.stringify({ canonical, providerId, action: "added" }));
  }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export type IdentityLinksRemoveOpts = {
  json?: boolean;
};

export async function identityLinksRemoveCommand(
  canonical: string,
  providerId: string | undefined,
  opts: IdentityLinksRemoveOpts,
  runtime: RuntimeEnv,
): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    runtime.error("Config invalid. Run openclaw doctor.");
    runtime.exit(1);
    return;
  }

  const config = snapshot.config ?? {};
  const links: Record<string, string[]> = { ...(config.session?.identityLinks ?? {}) };

  if (!(canonical in links)) {
    runtime.error(`No identity link found for "${canonical}".`);
    runtime.exit(1);
    return;
  }

  if (!providerId) {
    // Remove entire canonical entry
    delete links[canonical];
  } else {
    const normalizedTarget = providerId.toLowerCase();
    const before = links[canonical]!;
    const after = before.filter((id) => id.toLowerCase() !== normalizedTarget);
    if (after.length === before.length) {
      runtime.error(`"${providerId}" not found under "${canonical}".`);
      runtime.exit(1);
      return;
    }
    if (after.length === 0) {
      delete links[canonical];
    } else {
      links[canonical] = after;
    }
  }

  // Clean up empty identityLinks
  const hasLinks = Object.keys(links).length > 0;
  const session = { ...config.session };
  if (hasLinks) {
    session.identityLinks = links;
  } else {
    delete session.identityLinks;
  }

  const updated = {
    ...config,
    session: Object.keys(session).length > 0 ? session : undefined,
  };

  // Remove session key entirely if empty
  if (!updated.session) {
    delete (updated as Record<string, unknown>).session;
  }

  await writeConfigFile(updated);
  const detail = providerId
    ? `removed ${providerId} from ${canonical}`
    : `removed all links for ${canonical}`;
  logConfigUpdated(runtime, { suffix: `(identity-links: ${detail})` });

  if (opts.json) {
    runtime.log(JSON.stringify({ canonical, providerId: providerId ?? null, action: "removed" }));
  }
}

// ---------------------------------------------------------------------------
// Resolve (diagnostic)
// ---------------------------------------------------------------------------

export type IdentityLinksResolveOpts = {
  dmScope?: string;
  json?: boolean;
};

export async function identityLinksResolveCommand(
  channel: string,
  peerId: string,
  opts: IdentityLinksResolveOpts,
  runtime: RuntimeEnv,
): Promise<void> {
  const config = await requireValidConfig(runtime);
  if (!config) return;

  if (opts.dmScope && !VALID_DM_SCOPES.has(opts.dmScope)) {
    runtime.error(
      `Invalid DM scope: "${opts.dmScope}". Must be one of: ${[...VALID_DM_SCOPES].join(", ")}`,
    );
    runtime.exit(1);
    return;
  }

  const identityLinks = config.session?.identityLinks;
  const dmScope = (opts.dmScope ?? config.session?.dmScope ?? "main") as
    | "main"
    | "per-peer"
    | "per-channel-peer"
    | "per-account-channel-peer";

  const resolved = resolveLinkedPeerId({ identityLinks, channel, peerId });

  const sessionKey = buildAgentPeerSessionKey({
    agentId: "main",
    channel,
    peerId,
    peerKind: "dm",
    identityLinks,
    dmScope,
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify({
        channel,
        peerId,
        dmScope,
        resolvedCanonical: resolved,
        sessionKey,
      }),
    );
    return;
  }

  runtime.log(`Channel:    ${channel}`);
  runtime.log(`Peer ID:    ${peerId}`);
  runtime.log(`DM Scope:   ${dmScope}`);
  runtime.log(`Canonical:  ${resolved ?? "(none — no match)"}`);
  runtime.log(`Session Key: ${sessionKey}`);
}

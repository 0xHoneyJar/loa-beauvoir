import type { Command } from "commander";
import {
  identityLinksAddCommand,
  identityLinksListCommand,
  identityLinksRemoveCommand,
  identityLinksResolveCommand,
} from "../commands/identity-links.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerIdentityLinksCli(program: Command) {
  const identityLinks = program
    .command("identity-links")
    .description("Cross-provider identity link management");

  identityLinks
    .command("list")
    .description("List configured identity links")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await identityLinksListCommand({ json: Boolean(opts.json) }, defaultRuntime);
      });
    });

  identityLinks
    .command("add")
    .description("Link a provider ID to a canonical identity")
    .argument("<canonical>", "Canonical identity name (e.g. alice)")
    .argument("<providerId>", "Provider-prefixed peer ID (e.g. telegram:123456)")
    .option("--json", "Output JSON", false)
    .action(async (canonical: string, providerId: string, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await identityLinksAddCommand(
          canonical,
          providerId,
          { json: Boolean(opts.json) },
          defaultRuntime,
        );
      });
    });

  identityLinks
    .command("remove")
    .description("Remove identity link(s)")
    .argument("<canonical>", "Canonical identity name")
    .argument("[providerId]", "Provider ID to remove (omit to remove all)")
    .option("--json", "Output JSON", false)
    .action(async (canonical: string, providerId: string | undefined, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await identityLinksRemoveCommand(
          canonical,
          providerId,
          { json: Boolean(opts.json) },
          defaultRuntime,
        );
      });
    });

  identityLinks
    .command("resolve")
    .description("Resolve a channel:peerId to its canonical identity and session key")
    .argument("<channel>", "Channel name (e.g. telegram, discord)")
    .argument("<peerId>", "Peer ID within the channel")
    .option(
      "--dm-scope <scope>",
      "DM scope override (main|per-peer|per-channel-peer|per-account-channel-peer)",
    )
    .option("--json", "Output JSON", false)
    .action(async (channel: string, peerId: string, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await identityLinksResolveCommand(
          channel,
          peerId,
          {
            dmScope: opts.dmScope as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}

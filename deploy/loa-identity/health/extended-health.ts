/**
 * Extended Health Check
 *
 * Provides detailed status including tool loading progress and capability flags.
 *
 * @module deploy/loa-identity/health/extended-health
 */

import { getToolLoader, type LoaderState } from "../tool-loader/tool-loader.js";

/**
 * Extended health response with tool status
 */
export interface ExtendedHealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  gateway: "running" | "starting" | "stopped";
  uptime: number;
  version: string;
  mode: "core" | "full";
  tools: {
    loading: boolean;
    complete: boolean;
    directory: string;
    status: Record<string, string>;
    progress: {
      total: number;
      installed: number;
      failed: number;
      pending: number;
    };
  };
  capabilities: {
    semanticSearch: boolean; // ck-search
    taskGraph: boolean; // beads_rust
    memoryStack: boolean; // sentence-transformers
  };
}

/**
 * Get basic health response (fast, no tool status)
 */
export function getBasicHealth(startTime: number): { status: string; uptime: number } {
  return {
    status: "healthy",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

/**
 * Get extended health response with tool status
 */
export function getExtendedHealth(startTime: number): ExtendedHealthResponse {
  const loader = getToolLoader();
  const loaderState = loader.getStatus();

  // Build tool status map
  const toolStatus: Record<string, string> = {};
  for (const [name, status] of Object.entries(loaderState.tools)) {
    toolStatus[name] = status.status;
  }

  // Calculate progress
  const tools = Object.values(loaderState.tools);
  const progress = {
    total: tools.length,
    installed: tools.filter((t) => t.status === "installed").length,
    failed: tools.filter((t) => t.status === "failed").length,
    pending: tools.filter((t) => t.status === "pending" || t.status === "installing").length,
  };

  // Check capability availability
  const hasck = loaderState.tools["ck-search"]?.status === "installed";
  const hasBeads = loaderState.tools["beads_rust"]?.status === "installed";
  const hasTransformers = loaderState.tools["sentence-transformers"]?.status === "installed";

  // Determine overall status
  let status: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (progress.failed > 0 && progress.installed === 0) {
    status = "unhealthy";
  } else if (progress.failed > 0 || progress.pending > 0) {
    status = "degraded";
  }

  // Determine mode
  const isFullCapability = hasck && hasBeads && hasTransformers;
  const mode = isFullCapability ? "full" : "core";

  return {
    status,
    gateway: "running",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: process.env.LOA_VERSION ?? "1.27.0",
    mode,
    tools: {
      loading: !loader.isComplete(),
      complete: loader.isComplete(),
      directory: process.env.LOA_TOOL_DIR ?? "/data/tools",
      status: toolStatus,
      progress,
    },
    capabilities: {
      semanticSearch: hasck,
      taskGraph: hasBeads,
      memoryStack: hasTransformers,
    },
  };
}

/**
 * Format health response as plain text for simple health checks
 */
export function formatHealthText(health: ExtendedHealthResponse): string {
  const lines: string[] = [
    `status: ${health.status}`,
    `gateway: ${health.gateway}`,
    `uptime: ${health.uptime}s`,
    `mode: ${health.mode}`,
    "",
    "tools:",
  ];

  for (const [name, status] of Object.entries(health.tools.status)) {
    const icon =
      status === "installed"
        ? "✓"
        : status === "installing"
          ? "⟳"
          : status === "failed"
            ? "✗"
            : "○";
    lines.push(`  ${icon} ${name}: ${status}`);
  }

  lines.push("");
  lines.push("capabilities:");
  lines.push(`  semanticSearch: ${health.capabilities.semanticSearch ? "yes" : "no"}`);
  lines.push(`  taskGraph: ${health.capabilities.taskGraph ? "yes" : "no"}`);
  lines.push(`  memoryStack: ${health.capabilities.memoryStack ? "yes" : "no"}`);

  return lines.join("\n");
}

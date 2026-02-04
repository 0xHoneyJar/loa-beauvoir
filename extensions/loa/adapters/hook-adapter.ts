/**
 * Hook Adapter
 *
 * Isolates LOA plugin from OpenClaw SDK changes.
 * Provides a stable interface for hook registration.
 *
 * SDD Reference: Section 2.0 - SDK Adapter Layer
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type {
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
} from '../../../src/plugins/types.js';

/**
 * Handler for bootstrap hook (internal, runs on gateway start)
 */
export type BootstrapHandler = (
  event: PluginHookGatewayStartEvent,
  ctx: PluginHookGatewayContext,
) => Promise<void>;

/**
 * Handler for before_agent_start hook
 */
export type BeforeAgentStartHandler = (
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
) => Promise<PluginHookBeforeAgentStartResult | void>;

/**
 * Handler for agent_end hook
 */
export type AgentEndHandler = (
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
) => Promise<void>;

/**
 * SDK validation result
 */
export interface SdkValidationResult {
  valid: boolean;
  version: string;
  errors: string[];
}

/**
 * Hook adapter interface - isolates plugin from SDK changes
 */
export interface HookAdapter {
  /** Register bootstrap hook (runs on gateway start for SOUL.md generation) */
  registerBootstrapHook(handler: BootstrapHandler, priority?: number): void;
  /** Register before_agent_start hook (for context injection) */
  registerBeforeAgentStart(handler: BeforeAgentStartHandler, priority?: number): void;
  /** Register agent_end hook (for memory capture) */
  registerAgentEnd(handler: AgentEndHandler, priority?: number): void;
  /** Get workspace directory */
  getWorkspaceDir(): string;
  /** Validate SDK version and required APIs */
  validateSdkVersion(): SdkValidationResult;
}

/**
 * Create a hook adapter for the given plugin API
 */
export function createHookAdapter(api: OpenClawPluginApi): HookAdapter {
  // Store reference to api.on method (may change in future SDK versions)
  // Guard against undefined in validation scenarios
  const registerHook = api.on ? api.on.bind(api) : () => {};

  return {
    registerBootstrapHook(handler: BootstrapHandler, priority = 0): void {
      // Use gateway_start as the bootstrap point
      // SOUL.md should be ready before any agent runs
      registerHook('gateway_start', handler, { priority });
    },

    registerBeforeAgentStart(handler: BeforeAgentStartHandler, priority = 0): void {
      registerHook('before_agent_start', handler, { priority });
    },

    registerAgentEnd(handler: AgentEndHandler, priority = 0): void {
      registerHook('agent_end', handler, { priority });
    },

    getWorkspaceDir(): string {
      // Runtime provides workspace directory
      return api.runtime.workspaceDir ?? process.cwd();
    },

    validateSdkVersion(): SdkValidationResult {
      const errors: string[] = [];

      // Check required API methods exist
      if (typeof api.on !== 'function') {
        errors.push('api.on is not a function - hook registration unavailable');
      }

      if (typeof api.runtime !== 'object' || api.runtime === null) {
        errors.push('api.runtime is not available');
      }

      if (typeof api.logger !== 'object' || api.logger === null) {
        errors.push('api.logger is not available');
      }

      // Check for registerHook (alternative API)
      if (typeof api.registerHook !== 'function' && typeof api.on !== 'function') {
        errors.push('Neither api.registerHook nor api.on available');
      }

      // Get version from runtime or package
      const version = api.version ?? 'unknown';

      return {
        valid: errors.length === 0,
        version,
        errors,
      };
    },
  };
}

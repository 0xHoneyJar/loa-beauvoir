/**
 * Hook Adapter Tests
 *
 * Unit tests for SDK adapter validation and hook registration.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHookAdapter } from '../adapters/hook-adapter.js';

describe('HookAdapter', () => {
  const createMockApi = (overrides = {}) => ({
    id: 'loa',
    name: 'LOA',
    version: '2026.2.4',
    source: 'test',
    config: {},
    runtime: {
      workspaceDir: '/test/workspace',
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn(),
    registerHook: vi.fn(),
    registerTool: vi.fn(),
    registerChannel: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    ...overrides,
  });

  describe('validateSdkVersion', () => {
    it('should return valid when all required APIs exist', () => {
      const api = createMockApi();
      const adapter = createHookAdapter(api as any);

      const result = adapter.validateSdkVersion();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.version).toBe('2026.2.4');
    });

    it('should return invalid when api.on is missing', () => {
      const api = createMockApi({ on: undefined });
      const adapter = createHookAdapter(api as any);

      const result = adapter.validateSdkVersion();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('api.on is not a function - hook registration unavailable');
    });

    it('should return invalid when runtime is missing', () => {
      const api = createMockApi({ runtime: undefined });
      const adapter = createHookAdapter(api as any);

      const result = adapter.validateSdkVersion();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('api.runtime is not available');
    });

    it('should return invalid when logger is missing', () => {
      const api = createMockApi({ logger: undefined });
      const adapter = createHookAdapter(api as any);

      const result = adapter.validateSdkVersion();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('api.logger is not available');
    });
  });

  describe('getWorkspaceDir', () => {
    it('should return workspace directory from runtime', () => {
      const api = createMockApi();
      const adapter = createHookAdapter(api as any);

      expect(adapter.getWorkspaceDir()).toBe('/test/workspace');
    });

    it('should fall back to cwd when workspace not set', () => {
      const api = createMockApi({ runtime: { workspaceDir: undefined } });
      const adapter = createHookAdapter(api as any);

      expect(adapter.getWorkspaceDir()).toBe(process.cwd());
    });
  });

  describe('hook registration', () => {
    it('should register bootstrap hook with gateway_start', () => {
      const api = createMockApi();
      const adapter = createHookAdapter(api as any);
      const handler = vi.fn();

      adapter.registerBootstrapHook(handler, 100);

      expect(api.on).toHaveBeenCalledWith('gateway_start', handler, { priority: 100 });
    });

    it('should register before_agent_start hook', () => {
      const api = createMockApi();
      const adapter = createHookAdapter(api as any);
      const handler = vi.fn();

      adapter.registerBeforeAgentStart(handler, 50);

      expect(api.on).toHaveBeenCalledWith('before_agent_start', handler, { priority: 50 });
    });

    it('should register agent_end hook', () => {
      const api = createMockApi();
      const adapter = createHookAdapter(api as any);
      const handler = vi.fn();

      adapter.registerAgentEnd(handler, 50);

      expect(api.on).toHaveBeenCalledWith('agent_end', handler, { priority: 50 });
    });
  });
});

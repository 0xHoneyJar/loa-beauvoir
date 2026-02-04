/**
 * Learning Store Interface
 *
 * Wraps existing LearningStore to provide getActive() method.
 * Returns top N learnings by effectiveness.
 *
 * Sprint Task 2.4 - Flatline: IMP-008
 */

import type { PluginLogger } from '../../../src/plugins/types.js';

/**
 * Learning entry from the store
 */
export interface Learning {
  /** Learning ID */
  id: string;
  /** Learning content/description */
  content: string;
  /** Effectiveness score (0-100) */
  effectiveness: number;
  /** Whether learning is active/archived */
  status: 'active' | 'archived' | 'pending';
  /** Creation timestamp */
  createdAt: string;
  /** Last applied timestamp */
  lastApplied?: string;
  /** Application count */
  applicationCount: number;
}

/**
 * Learning store interface
 */
export interface LearningStore {
  /** Get active learnings sorted by effectiveness */
  getActive(limit?: number): Promise<Learning[]>;
  /** Get a specific learning by ID */
  get(id: string): Promise<Learning | null>;
  /** Check if any learnings exist */
  hasLearnings(): Promise<boolean>;
}

/**
 * Create a learning store wrapper
 *
 * This wraps the existing LearningStore from deploy/loa-identity
 * or grimoires/loa/a2a/compound/learnings.json
 */
export function createLearningStore(
  workspaceDir: string,
  logger: PluginLogger,
): LearningStore {
  const path = require('node:path');
  const fs = require('node:fs/promises');

  const learningsPath = path.join(workspaceDir, 'grimoires/loa/a2a/compound/learnings.json');

  /**
   * Load learnings from file
   */
  async function loadLearnings(): Promise<Learning[]> {
    try {
      const content = await fs.readFile(learningsPath, 'utf-8');
      const data = JSON.parse(content);

      // Handle both array and object formats
      if (Array.isArray(data)) {
        return data;
      }
      if (data.learnings && Array.isArray(data.learnings)) {
        return data.learnings;
      }
      return [];
    } catch (err) {
      // File doesn't exist or is invalid - return empty
      return [];
    }
  }

  return {
    async getActive(limit = 10): Promise<Learning[]> {
      const learnings = await loadLearnings();

      // Filter to active learnings
      const active = learnings.filter((l) => l.status === 'active' || !l.status);

      // Sort by effectiveness (descending)
      active.sort((a, b) => (b.effectiveness ?? 0) - (a.effectiveness ?? 0));

      // Return top N
      return active.slice(0, limit);
    },

    async get(id: string): Promise<Learning | null> {
      const learnings = await loadLearnings();
      return learnings.find((l) => l.id === id) ?? null;
    },

    async hasLearnings(): Promise<boolean> {
      const learnings = await loadLearnings();
      return learnings.length > 0;
    },
  };
}

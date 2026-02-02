/**
 * Loa Cloud Stack - Learning Store
 *
 * CRUD operations for compound learnings with persistence to grimoires.
 *
 * Storage locations:
 *   - Active learnings: grimoires/loa/a2a/compound/learnings.json
 *   - Pending self-improvements: grimoires/loa/a2a/compound/pending-self/
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Learning, LearningsStore, LearningStatus, LearningTarget } from './types';
import { scoreAllGates, passesQualityGates } from './quality-gates';
import { getWALManager } from './wal-manager';

// =============================================================================
// Configuration
// =============================================================================

const GRIMOIRES_DIR = process.env.GRIMOIRES_DIR || '/workspace/grimoires';
const LEARNINGS_FILE = 'loa/a2a/compound/learnings.json';
const PENDING_SELF_DIR = 'loa/a2a/compound/pending-self';

// =============================================================================
// Learning Store Class
// =============================================================================

export class LearningStore {
  private grimoiresDir: string;

  constructor(grimoiresDir: string = GRIMOIRES_DIR) {
    this.grimoiresDir = grimoiresDir;
  }

  // ---------------------------------------------------------------------------
  // Path Helpers
  // ---------------------------------------------------------------------------

  private get learningsPath(): string {
    return path.join(this.grimoiresDir, LEARNINGS_FILE);
  }

  private get pendingSelfDir(): string {
    return path.join(this.grimoiresDir, PENDING_SELF_DIR);
  }

  // ---------------------------------------------------------------------------
  // Store Operations
  // ---------------------------------------------------------------------------

  /**
   * Load the learnings store from disk
   */
  async loadStore(): Promise<LearningsStore> {
    try {
      const data = await fs.promises.readFile(this.learningsPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return {
        version: '1.0.0',
        learnings: [],
      };
    }
  }

  /**
   * Save the learnings store to disk (with WAL protection)
   */
  async saveStore(store: LearningsStore): Promise<void> {
    const wal = getWALManager();
    const content = JSON.stringify(store, null, 2);
    await wal.write(LEARNINGS_FILE, content);
  }

  // ---------------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------------

  /**
   * Add a new learning
   * If target is 'loa' (self-improvement), it goes to pending-self
   */
  async addLearning(
    learning: Omit<Learning, 'id' | 'created' | 'gates' | 'status'>
  ): Promise<Learning> {
    const id = uuidv4();
    const created = new Date().toISOString();
    const gates = scoreAllGates(learning);

    const newLearning: Learning = {
      ...learning,
      id,
      created,
      gates,
      status: 'pending',
    };

    // Check quality gates
    if (!passesQualityGates(newLearning)) {
      console.log(`[learning-store] Learning ${id} did not pass quality gates, discarding`);
      return newLearning;
    }

    // Self-improvement requires human approval
    if (learning.target === 'loa') {
      await this.savePendingSelf(newLearning);
      console.log(`[learning-store] Self-improvement learning ${id} saved to pending-self`);
    } else {
      // Other targets can be auto-activated
      newLearning.status = 'active';
      const store = await this.loadStore();
      store.learnings.push(newLearning);
      await this.saveStore(store);
      console.log(`[learning-store] Learning ${id} activated for target: ${learning.target}`);
    }

    return newLearning;
  }

  /**
   * Get a learning by ID
   */
  async getLearning(id: string): Promise<Learning | null> {
    // Check active store first
    const store = await this.loadStore();
    const learning = store.learnings.find((l) => l.id === id);
    if (learning) return learning;

    // Check pending-self
    const pendingPath = path.join(this.pendingSelfDir, `${id}.json`);
    try {
      const data = await fs.promises.readFile(pendingPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Get all learnings, optionally filtered by status
   */
  async getLearnings(status?: LearningStatus): Promise<Learning[]> {
    const store = await this.loadStore();
    let learnings = store.learnings;

    if (status) {
      learnings = learnings.filter((l) => l.status === status);
    }

    return learnings;
  }

  /**
   * Get learnings by target
   */
  async getLearningsByTarget(target: LearningTarget): Promise<Learning[]> {
    const store = await this.loadStore();
    return store.learnings.filter((l) => l.target === target);
  }

  /**
   * Get all pending self-improvement learnings
   */
  async getPendingLearnings(): Promise<Learning[]> {
    const pending: Learning[] = [];

    try {
      await fs.promises.mkdir(this.pendingSelfDir, { recursive: true });
      const files = await fs.promises.readdir(this.pendingSelfDir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await fs.promises.readFile(
            path.join(this.pendingSelfDir, file),
            'utf8'
          );
          pending.push(JSON.parse(data));
        } catch {
          // Skip invalid files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return pending;
  }

  /**
   * Update a learning's status
   */
  async updateLearningStatus(
    id: string,
    status: LearningStatus,
    approvedBy?: string
  ): Promise<Learning | null> {
    // Try to find in pending-self first (for approvals)
    const pendingPath = path.join(this.pendingSelfDir, `${id}.json`);

    try {
      const data = await fs.promises.readFile(pendingPath, 'utf8');
      const learning: Learning = JSON.parse(data);

      learning.status = status;
      if (status === 'approved' || status === 'active') {
        learning.approved_by = approvedBy;
        learning.approved_at = new Date().toISOString();

        // Move from pending to active store
        const store = await this.loadStore();
        learning.status = 'active'; // Approved = active
        store.learnings.push(learning);
        await this.saveStore(store);

        // Remove from pending
        await fs.promises.unlink(pendingPath);

        console.log(`[learning-store] Learning ${id} approved and activated`);
        return learning;
      } else if (status === 'archived') {
        // Just delete from pending
        await fs.promises.unlink(pendingPath);
        console.log(`[learning-store] Learning ${id} archived (rejected)`);
        return learning;
      }
    } catch {
      // Not in pending-self, try active store
    }

    // Update in active store
    const store = await this.loadStore();
    const index = store.learnings.findIndex((l) => l.id === id);

    if (index === -1) {
      return null;
    }

    store.learnings[index].status = status;
    if (approvedBy) {
      store.learnings[index].approved_by = approvedBy;
      store.learnings[index].approved_at = new Date().toISOString();
    }

    await this.saveStore(store);
    return store.learnings[index];
  }

  /**
   * Record a learning application (for effectiveness tracking)
   */
  async recordApplication(
    id: string,
    success: boolean
  ): Promise<Learning | null> {
    const store = await this.loadStore();
    const index = store.learnings.findIndex((l) => l.id === id);

    if (index === -1) {
      return null;
    }

    const learning = store.learnings[index];

    if (!learning.effectiveness) {
      learning.effectiveness = {
        applications: 0,
        successes: 0,
        failures: 0,
      };
    }

    learning.effectiveness.applications++;
    if (success) {
      learning.effectiveness.successes++;
    } else {
      learning.effectiveness.failures++;
    }
    learning.effectiveness.last_applied = new Date().toISOString();

    await this.saveStore(store);
    return learning;
  }

  // ---------------------------------------------------------------------------
  // Pending Self Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a learning to pending-self directory
   */
  private async savePendingSelf(learning: Learning): Promise<void> {
    await fs.promises.mkdir(this.pendingSelfDir, { recursive: true });
    const filePath = path.join(this.pendingSelfDir, `${learning.id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(learning, null, 2));

    // Also write via WAL for persistence
    const wal = getWALManager();
    await wal.write(
      `${PENDING_SELF_DIR}/${learning.id}.json`,
      JSON.stringify(learning, null, 2)
    );
  }

  // ---------------------------------------------------------------------------
  // Query Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get active learnings that match a given context
   */
  async findMatchingLearnings(context: string): Promise<Learning[]> {
    const store = await this.loadStore();
    const active = store.learnings.filter((l) => l.status === 'active');

    // Simple keyword matching (could be enhanced with embeddings)
    const contextLower = context.toLowerCase();
    const matches = active.filter((l) => {
      const triggerLower = l.trigger.toLowerCase();
      const patternLower = l.pattern.toLowerCase();

      // Check if context mentions keywords from trigger or pattern
      const triggerWords = triggerLower.split(/\s+/);
      const patternWords = patternLower.split(/\s+/);

      const matchCount = [...triggerWords, ...patternWords].filter(
        (word) => word.length > 3 && contextLower.includes(word)
      ).length;

      return matchCount >= 2;
    });

    return matches;
  }

  /**
   * Get statistics about the learning store
   */
  async getStats(): Promise<{
    total: number;
    byStatus: Record<LearningStatus, number>;
    byTarget: Record<LearningTarget, number>;
    pendingSelf: number;
  }> {
    const store = await this.loadStore();
    const pending = await this.getPendingLearnings();

    const byStatus: Record<string, number> = {
      pending: 0,
      approved: 0,
      active: 0,
      archived: 0,
    };
    const byTarget: Record<string, number> = {
      loa: 0,
      devcontainer: 0,
      moltworker: 0,
      openclaw: 0,
    };

    for (const learning of store.learnings) {
      byStatus[learning.status]++;
      byTarget[learning.target]++;
    }

    return {
      total: store.learnings.length,
      byStatus: byStatus as Record<LearningStatus, number>,
      byTarget: byTarget as Record<LearningTarget, number>,
      pendingSelf: pending.length,
    };
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let instance: LearningStore | null = null;

export function getLearningStore(): LearningStore {
  if (!instance) {
    instance = new LearningStore();
  }
  return instance;
}

export default LearningStore;

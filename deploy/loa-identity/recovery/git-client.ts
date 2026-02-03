/**
 * Git Client - Git restore fallback
 *
 * Provides restore functionality from git repository
 * as a fallback when R2 is unavailable.
 *
 * @module deploy/loa-identity/recovery/git-client
 */

import { readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { StateManifest } from '../security/manifest-signer.js';

const exec = promisify(execCb);

export interface GitClientConfig {
  repoUrl: string;
  branch: string;
  localPath: string;
  grimoiresSubdir: string;
}

/**
 * GitClient handles restore operations from git repository.
 */
export class GitClient {
  private config: GitClientConfig;

  constructor(config: GitClientConfig) {
    this.config = config;
  }

  /**
   * Check if git is available and repo is accessible
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check if git is installed
      await exec('git --version');

      // Check if we can access the remote (if not already cloned)
      if (!existsSync(join(this.config.localPath, '.git'))) {
        // Try to list remote refs
        const { stdout } = await exec(
          `git ls-remote --exit-code ${this.config.repoUrl} HEAD`,
          { timeout: 10000 }
        );
        return stdout.length > 0;
      }

      return true;
    } catch (e) {
      console.warn('[git-client] Git not available:', e);
      return false;
    }
  }

  /**
   * Clone or pull the repository
   */
  async cloneOrPull(): Promise<boolean> {
    try {
      if (existsSync(join(this.config.localPath, '.git'))) {
        // Already cloned, pull latest
        return await this.pull();
      } else {
        // Clone fresh
        return await this.clone();
      }
    } catch (e) {
      console.error('[git-client] Clone/pull error:', e);
      return false;
    }
  }

  /**
   * Clone the repository
   */
  private async clone(): Promise<boolean> {
    console.log(`[git-client] Cloning ${this.config.repoUrl}...`);

    try {
      await exec(
        `git clone --depth 1 --branch ${this.config.branch} ${this.config.repoUrl} ${this.config.localPath}`,
        { timeout: 120000 } // 2 minute timeout
      );

      console.log('[git-client] Clone complete');
      return true;
    } catch (e) {
      console.error('[git-client] Clone failed:', e);
      return false;
    }
  }

  /**
   * Pull latest changes
   */
  private async pull(): Promise<boolean> {
    console.log('[git-client] Pulling latest changes...');

    try {
      await exec('git fetch origin', {
        cwd: this.config.localPath,
        timeout: 60000,
      });

      await exec(`git reset --hard origin/${this.config.branch}`, {
        cwd: this.config.localPath,
        timeout: 30000,
      });

      console.log('[git-client] Pull complete');
      return true;
    } catch (e) {
      console.error('[git-client] Pull failed:', e);
      return false;
    }
  }

  /**
   * Get manifest from git
   */
  async getManifest(): Promise<StateManifest | null> {
    const manifestPath = join(
      this.config.localPath,
      this.config.grimoiresSubdir,
      'loa',
      'manifest.json'
    );

    if (!existsSync(manifestPath)) {
      console.log('[git-client] No manifest in git repository');
      return null;
    }

    try {
      const content = await readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as StateManifest;
    } catch (e) {
      console.warn('[git-client] Failed to read manifest:', e);
      return null;
    }
  }

  /**
   * Get a file from git
   */
  async getFile(relativePath: string): Promise<Buffer | null> {
    const fullPath = join(
      this.config.localPath,
      this.config.grimoiresSubdir,
      relativePath
    );

    if (!existsSync(fullPath)) {
      return null;
    }

    try {
      return await readFile(fullPath);
    } catch (e) {
      console.warn(`[git-client] Failed to read ${relativePath}:`, e);
      return null;
    }
  }

  /**
   * Get git commit info
   */
  async getCommitInfo(): Promise<{
    hash: string;
    message: string;
    date: string;
  } | null> {
    if (!existsSync(join(this.config.localPath, '.git'))) {
      return null;
    }

    try {
      const { stdout: hash } = await exec('git rev-parse HEAD', {
        cwd: this.config.localPath,
      });

      const { stdout: message } = await exec('git log -1 --format=%s', {
        cwd: this.config.localPath,
      });

      const { stdout: date } = await exec('git log -1 --format=%ci', {
        cwd: this.config.localPath,
      });

      return {
        hash: hash.trim(),
        message: message.trim(),
        date: date.trim(),
      };
    } catch (e) {
      console.warn('[git-client] Failed to get commit info:', e);
      return null;
    }
  }

  /**
   * Check if local repo has uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    if (!existsSync(join(this.config.localPath, '.git'))) {
      return false;
    }

    try {
      const { stdout } = await exec('git status --porcelain', {
        cwd: this.config.localPath,
      });

      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Commit and push changes
   */
  async commitAndPush(message: string): Promise<boolean> {
    if (!existsSync(join(this.config.localPath, '.git'))) {
      return false;
    }

    try {
      // Stage all changes in grimoires
      await exec(`git add ${this.config.grimoiresSubdir}/`, {
        cwd: this.config.localPath,
      });

      // Check if there are changes to commit
      const { stdout: status } = await exec('git status --porcelain', {
        cwd: this.config.localPath,
      });

      if (!status.trim()) {
        console.log('[git-client] No changes to commit');
        return true;
      }

      // Commit
      const commitMsg = `${message}

Co-Authored-By: Loa Framework <noreply@loa.dev>`;

      await exec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
        cwd: this.config.localPath,
      });

      // Push
      await exec('git push', {
        cwd: this.config.localPath,
        timeout: 60000,
      });

      console.log('[git-client] Changes committed and pushed');
      return true;
    } catch (e) {
      console.error('[git-client] Commit/push failed:', e);
      return false;
    }
  }

  /**
   * Get the grimoires directory path
   */
  getGrimoiresPath(): string {
    return join(this.config.localPath, this.config.grimoiresSubdir);
  }
}

/**
 * Create a GitClient with default configuration
 */
export function createGitClient(
  repoUrl: string,
  localPath: string,
  branch = 'main'
): GitClient {
  return new GitClient({
    repoUrl,
    branch,
    localPath,
    grimoiresSubdir: 'grimoires',
  });
}

/**
 * Create a GitClient from environment variables
 */
export function createGitClientFromEnv(): GitClient | null {
  const repoUrl = process.env.LOA_GIT_REPO;
  const localPath = process.env.LOA_GIT_LOCAL_PATH ?? '/workspace';
  const branch = process.env.LOA_GIT_BRANCH ?? 'main';

  if (!repoUrl) {
    console.log('[git-client] LOA_GIT_REPO not set, git fallback disabled');
    return null;
  }

  return createGitClient(repoUrl, localPath, branch);
}

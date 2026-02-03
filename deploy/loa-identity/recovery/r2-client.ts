/**
 * R2 Client - Cloudflare R2 restore client (mount-only)
 *
 * SECURITY: This client ONLY supports R2 access via filesystem mount
 * (rclone/goofys). Direct API access is NOT supported because:
 * 1. AWS Signature V4 requires complex crypto implementation
 * 2. Third-party aws4 packages introduce supply chain risk
 * 3. Mount-based access is already verified in production
 *
 * If you need API access, use the rclone CLI or mount the bucket.
 *
 * Provides restore functionality from R2 storage with
 * SHA-256 verification (not ETag which is MD5).
 *
 * @module deploy/loa-identity/recovery/r2-client
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { StateManifest } from '../security/manifest-signer.js';

export interface R2MountConfig {
  mountPath: string;
  prefix?: string;
}

/**
 * R2Client handles backup and restore operations with Cloudflare R2
 * via filesystem mount ONLY.
 *
 * SECURITY: Direct API access is intentionally not supported.
 * Use rclone mount or goofys to mount R2 as a filesystem.
 */
export class R2Client {
  private mountPath: string;
  private prefix: string;

  constructor(config: R2MountConfig) {
    this.mountPath = config.mountPath;
    this.prefix = config.prefix ?? 'grimoires';
  }

  /**
   * Check if R2 mount is available
   */
  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.mountPath)) {
      console.warn(`[r2-client] Mount path not found: ${this.mountPath}`);
      return false;
    }

    // Verify it's actually mounted (not just an empty directory)
    try {
      const entries = await readdir(this.mountPath);
      // A mounted R2 bucket should have at least the prefix directory
      return entries.length > 0 || existsSync(join(this.mountPath, this.prefix));
    } catch (e) {
      console.warn(`[r2-client] Mount check failed: ${e}`);
      return false;
    }
  }

  /**
   * Download manifest from R2 mount
   */
  async downloadManifest(): Promise<StateManifest | null> {
    try {
      const manifestPath = `${this.prefix}/loa/manifest.json`;
      const content = await this.downloadFile(manifestPath);

      if (!content) {
        return null;
      }

      return JSON.parse(content.toString()) as StateManifest;
    } catch (e) {
      console.warn('[r2-client] Failed to download manifest:', e);
      return null;
    }
  }

  /**
   * Download a file from R2 mount
   */
  async downloadFile(relativePath: string): Promise<Buffer | null> {
    const fullPath = join(this.mountPath, relativePath);

    if (!existsSync(fullPath)) {
      return null;
    }

    try {
      return await readFile(fullPath);
    } catch (e) {
      console.warn(`[r2-client] Download failed: ${relativePath}`, e);
      return null;
    }
  }

  /**
   * Upload a file to R2 mount
   */
  async uploadFile(relativePath: string, content: Buffer): Promise<boolean> {
    const fullPath = join(this.mountPath, relativePath);

    try {
      await mkdir(dirname(fullPath), { recursive: true });

      // Atomic write
      const tempPath = `${fullPath}.tmp`;
      await writeFile(tempPath, content);
      const { rename } = await import('fs/promises');
      await rename(tempPath, fullPath);

      return true;
    } catch (e) {
      console.error(`[r2-client] Upload failed: ${relativePath}`, e);
      return false;
    }
  }

  /**
   * Upload manifest to R2 mount
   */
  async uploadManifest(manifest: StateManifest): Promise<boolean> {
    const manifestPath = `${this.prefix}/loa/manifest.json`;
    const content = Buffer.from(JSON.stringify(manifest, null, 2));
    return this.uploadFile(manifestPath, content);
  }

  /**
   * List files in R2 mount
   */
  async listFiles(subPrefix?: string): Promise<string[]> {
    const fullPrefix = subPrefix
      ? `${this.prefix}/${subPrefix}`
      : this.prefix;

    const fullPath = join(this.mountPath, fullPrefix);

    if (!existsSync(fullPath)) {
      return [];
    }

    const files: string[] = [];

    async function walk(dir: string, base: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullEntryPath = join(dir, entry.name);
        const relativePath = join(base, entry.name);

        if (entry.isDirectory()) {
          await walk(fullEntryPath, relativePath);
        } else {
          files.push(relativePath);
        }
      }
    }

    await walk(fullPath, '');
    return files;
  }

  /**
   * Sync local directory to R2 mount
   */
  async syncToR2(
    localDir: string,
    callback?: (file: string, status: 'uploaded' | 'skipped') => void
  ): Promise<{ uploaded: number; skipped: number }> {
    let uploaded = 0;
    let skipped = 0;

    const self = this;

    async function walk(dir: string, prefix: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const localPath = join(dir, entry.name);
        const remotePath = `${prefix}/${entry.name}`;

        if (entry.isDirectory()) {
          await walk(localPath, remotePath);
        } else {
          const content = await readFile(localPath);
          const success = await self.uploadFile(remotePath, content);

          if (success) {
            uploaded++;
            callback?.(remotePath, 'uploaded');
          } else {
            skipped++;
            callback?.(remotePath, 'skipped');
          }
        }
      }
    }

    await walk(localDir, this.prefix);

    return { uploaded, skipped };
  }

  /**
   * Verify file checksum against expected SHA-256
   */
  verifyChecksum(content: Buffer, expectedSha256: string): boolean {
    const actual = createHash('sha256').update(content).digest('hex');
    return actual === expectedSha256;
  }
}

/**
 * Create R2 client from mount path
 *
 * SECURITY: This is the ONLY way to create an R2Client.
 * Direct API access is not supported.
 *
 * @param mountPath - Path to the mounted R2 bucket (e.g., /data/moltbot)
 * @param prefix - Optional prefix within the bucket (default: 'grimoires')
 */
export function createR2ClientFromMount(mountPath: string, prefix?: string): R2Client {
  if (!mountPath) {
    throw new Error('R2 mount path is required. Direct API access is not supported.');
  }

  return new R2Client({ mountPath, prefix });
}

/**
 * Create R2 client from environment variables
 *
 * Expects LOA_R2_MOUNT_PATH to be set.
 */
export function createR2ClientFromEnv(): R2Client | null {
  const mountPath = process.env.LOA_R2_MOUNT_PATH;

  if (!mountPath) {
    console.log('[r2-client] LOA_R2_MOUNT_PATH not set, R2 disabled');
    return null;
  }

  return createR2ClientFromMount(mountPath);
}

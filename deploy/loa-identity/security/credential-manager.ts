/**
 * Credential Manager - Secure credential loading and management
 *
 * Implements hierarchical credential loading:
 * 1. Cloudflare Secrets (production)
 * 2. Environment variables (container)
 * 3. Local .env file (development only)
 *
 * @module deploy/loa-identity/security/credential-manager
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
}

export interface SigningCredentials {
  privateKey: string;
  publicKey: string;
}

export interface CredentialSource {
  source: 'cloudflare' | 'env' | 'dotenv';
  loadedAt: Date;
}

/**
 * CredentialManager handles secure loading of credentials with fallback hierarchy.
 */
export class CredentialManager {
  private loaded = false;
  private source: CredentialSource | null = null;
  private r2Credentials: R2Credentials | null = null;
  private signingCredentials: SigningCredentials | null = null;

  /**
   * Initialize and load credentials from available sources
   */
  async initialize(): Promise<void> {
    if (this.loaded) return;

    // Try each source in priority order
    if (await this.tryCloudflareSecrets()) {
      this.source = { source: 'cloudflare', loadedAt: new Date() };
    } else if (this.tryEnvironmentVariables()) {
      this.source = { source: 'env', loadedAt: new Date() };
    } else if (await this.tryDotEnvFile()) {
      this.source = { source: 'dotenv', loadedAt: new Date() };
    }

    this.loaded = true;

    if (this.source) {
      console.log(
        `[credential-manager] Loaded credentials from: ${this.source.source}`
      );
    } else {
      console.warn('[credential-manager] No credentials found');
    }
  }

  /**
   * Try to load from Cloudflare Workers Secrets
   */
  private async tryCloudflareSecrets(): Promise<boolean> {
    // Cloudflare Secrets are accessed via globalThis in Workers environment
    // They appear as environment variables but are encrypted at rest
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const privateKey = process.env.LOA_SIGNING_KEY;
    const publicKey = process.env.LOA_PUBLIC_KEY;

    // Check for Cloudflare-specific marker
    const isCloudflare = process.env.CF_WORKER || process.env.CLOUDFLARE_WORKER;

    if (isCloudflare && accessKeyId && secretAccessKey) {
      this.r2Credentials = {
        accessKeyId,
        secretAccessKey,
        endpoint:
          process.env.R2_ENDPOINT || 'https://accountid.r2.cloudflarestorage.com',
        bucket: process.env.R2_BUCKET || 'loa-beauvoir-data',
      };

      if (privateKey && publicKey) {
        this.signingCredentials = { privateKey, publicKey };
      }

      return true;
    }

    return false;
  }

  /**
   * Try to load from standard environment variables
   */
  private tryEnvironmentVariables(): boolean {
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (accessKeyId && secretAccessKey) {
      this.r2Credentials = {
        accessKeyId,
        secretAccessKey,
        endpoint:
          process.env.R2_ENDPOINT || 'https://accountid.r2.cloudflarestorage.com',
        bucket: process.env.R2_BUCKET || 'loa-beauvoir-data',
      };

      const privateKey = process.env.LOA_SIGNING_KEY;
      const publicKey = process.env.LOA_PUBLIC_KEY;

      if (privateKey && publicKey) {
        this.signingCredentials = { privateKey, publicKey };
      }

      return true;
    }

    return false;
  }

  /**
   * Try to load from .env file (development only)
   */
  private async tryDotEnvFile(): Promise<boolean> {
    // Only in development
    if (process.env.NODE_ENV === 'production') {
      return false;
    }

    const envPaths = ['.env', '.env.local', '/workspace/.env'];

    for (const envPath of envPaths) {
      if (existsSync(envPath)) {
        try {
          const content = await readFile(envPath, 'utf-8');
          const vars = this.parseDotEnv(content);

          const accessKeyId = vars.R2_ACCESS_KEY_ID;
          const secretAccessKey = vars.R2_SECRET_ACCESS_KEY;

          if (accessKeyId && secretAccessKey) {
            this.r2Credentials = {
              accessKeyId,
              secretAccessKey,
              endpoint:
                vars.R2_ENDPOINT ||
                'https://accountid.r2.cloudflarestorage.com',
              bucket: vars.R2_BUCKET || 'loa-beauvoir-data',
            };

            if (vars.LOA_SIGNING_KEY && vars.LOA_PUBLIC_KEY) {
              this.signingCredentials = {
                privateKey: vars.LOA_SIGNING_KEY,
                publicKey: vars.LOA_PUBLIC_KEY,
              };
            }

            console.warn(
              `[credential-manager] Loaded from ${envPath} - development only!`
            );
            return true;
          }
        } catch {
          // Continue to next file
        }
      }
    }

    return false;
  }

  /**
   * Parse .env file content
   */
  private parseDotEnv(content: string): Record<string, string> {
    const vars: Record<string, string> = {};

    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();

        // Remove quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        vars[key] = value;
      }
    }

    return vars;
  }

  /**
   * Get R2 credentials
   */
  getR2Credentials(): R2Credentials {
    if (!this.loaded) {
      throw new Error('CredentialManager not initialized. Call initialize() first.');
    }

    if (!this.r2Credentials) {
      throw new Error(
        'R2 credentials not available. ' +
          'Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY environment variables.'
      );
    }

    return this.r2Credentials;
  }

  /**
   * Get signing credentials
   */
  getSigningCredentials(): SigningCredentials {
    if (!this.loaded) {
      throw new Error('CredentialManager not initialized. Call initialize() first.');
    }

    if (!this.signingCredentials) {
      throw new Error(
        'Signing credentials not available. ' +
          'Set LOA_SIGNING_KEY and LOA_PUBLIC_KEY environment variables.'
      );
    }

    return this.signingCredentials;
  }

  /**
   * Check if R2 credentials are available
   */
  hasR2Credentials(): boolean {
    return this.r2Credentials !== null;
  }

  /**
   * Check if signing credentials are available
   */
  hasSigningCredentials(): boolean {
    return this.signingCredentials !== null;
  }

  /**
   * Get credential source information
   */
  getSource(): CredentialSource | null {
    return this.source;
  }

  /**
   * Check if running in production mode
   */
  isProduction(): boolean {
    return (
      process.env.NODE_ENV === 'production' ||
      this.source?.source === 'cloudflare'
    );
  }
}

// Singleton instance
let instance: CredentialManager | null = null;

/**
 * Get singleton CredentialManager instance
 */
export function getCredentialManager(): CredentialManager {
  if (!instance) {
    instance = new CredentialManager();
  }
  return instance;
}

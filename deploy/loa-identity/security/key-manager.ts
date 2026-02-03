/**
 * Key Manager - Ed25519 Key Lifecycle Management
 *
 * Implements 90-day key rotation with 7-day overlap periods.
 * Supports emergency revocation and multi-key verification.
 *
 * @module deploy/loa-identity/security/key-manager
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { createHash, randomBytes } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import * as yaml from 'yaml';
import { AuditLogger } from './audit-logger.js';

// Configure ed25519 to use sha512
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface KeyInfo {
  id: string;
  publicKey: string; // hex-encoded
  createdAt: string;
  expiresAt: string;
  status: 'active' | 'retired' | 'revoked';
  retiredAt?: string;
  revokedAt?: string;
  revocationReason?: string;
}

export interface KeyRegistry {
  version: number;
  activeKeyId: string | null;
  keys: KeyInfo[];
  rotationPolicy: {
    rotationDays: number;
    overlapDays: number;
    maxRetiredKeys: number;
  };
}

export interface KeyManagerConfig {
  registryPath: string;
  rotationDays?: number;
  overlapDays?: number;
  maxRetiredKeys?: number;
  auditLogger?: AuditLogger;
}

/**
 * KeyManager handles the complete lifecycle of Ed25519 signing keys.
 *
 * Key Lifecycle:
 * 1. Generation - New key created with 90-day validity
 * 2. Active - Current signing key (only one at a time)
 * 3. Retired - Previous key, still valid for verification during overlap
 * 4. Expired - No longer valid for signing or verification
 * 5. Revoked - Emergency invalidation (immediate effect)
 */
export class KeyManager {
  private config: Required<Omit<KeyManagerConfig, 'auditLogger'>> & {
    auditLogger?: AuditLogger;
  };
  private registry: KeyRegistry | null = null;
  private initialized = false;

  constructor(config: KeyManagerConfig) {
    this.config = {
      registryPath: config.registryPath,
      rotationDays: config.rotationDays ?? 90,
      overlapDays: config.overlapDays ?? 7,
      maxRetiredKeys: config.maxRetiredKeys ?? 3,
      auditLogger: config.auditLogger,
    };
  }

  /**
   * Initialize the key manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    const dir = dirname(this.config.registryPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Load or create registry
    if (existsSync(this.config.registryPath)) {
      await this.loadRegistry();
    } else {
      this.registry = this.createEmptyRegistry();
      await this.saveRegistry();
    }

    this.initialized = true;
  }

  /**
   * Create empty registry structure
   */
  private createEmptyRegistry(): KeyRegistry {
    return {
      version: 1,
      activeKeyId: null,
      keys: [],
      rotationPolicy: {
        rotationDays: this.config.rotationDays,
        overlapDays: this.config.overlapDays,
        maxRetiredKeys: this.config.maxRetiredKeys,
      },
    };
  }

  /**
   * Load registry from file
   */
  private async loadRegistry(): Promise<void> {
    const content = await readFile(this.config.registryPath, 'utf-8');
    this.registry = yaml.parse(content) as KeyRegistry;
  }

  /**
   * Save registry to file
   */
  private async saveRegistry(): Promise<void> {
    if (!this.registry) return;
    const content = yaml.stringify(this.registry);
    await writeFile(this.config.registryPath, content, 'utf-8');
  }

  /**
   * Generate a new Ed25519 key pair
   */
  async generateKey(): Promise<{ keyId: string; privateKeyHex: string }> {
    if (!this.initialized) await this.initialize();

    // Generate new key pair
    const privateKey = randomBytes(32);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const keyId = this.computeKeyId(publicKey);

    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + this.config.rotationDays);

    const keyInfo: KeyInfo = {
      id: keyId,
      publicKey: Buffer.from(publicKey).toString('hex'),
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'active',
    };

    // Retire current active key if exists
    if (this.registry!.activeKeyId) {
      await this.retireKey(this.registry!.activeKeyId);
    }

    // Add new key and set as active
    this.registry!.keys.push(keyInfo);
    this.registry!.activeKeyId = keyId;

    await this.saveRegistry();

    // Audit log
    await this.config.auditLogger?.log(
      'key_generated',
      {
        keyId,
        expiresAt: expiresAt.toISOString(),
        previousActiveKey: this.registry!.activeKeyId,
      },
      'system'
    );

    // Clean up old retired keys
    await this.cleanupRetiredKeys();

    return {
      keyId,
      privateKeyHex: privateKey.toString('hex'),
    };
  }

  /**
   * Retire a key (still valid for verification during overlap)
   */
  async retireKey(keyId: string): Promise<void> {
    if (!this.initialized) await this.initialize();

    const key = this.registry!.keys.find((k) => k.id === keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }

    if (key.status === 'revoked') {
      throw new Error(`Cannot retire revoked key: ${keyId}`);
    }

    const now = new Date();
    const newExpiresAt = new Date(now);
    newExpiresAt.setDate(newExpiresAt.getDate() + this.config.overlapDays);

    key.status = 'retired';
    key.retiredAt = now.toISOString();
    // Shorten expiration to overlap period
    key.expiresAt = newExpiresAt.toISOString();

    if (this.registry!.activeKeyId === keyId) {
      this.registry!.activeKeyId = null;
    }

    await this.saveRegistry();

    await this.config.auditLogger?.log(
      'key_retired',
      {
        keyId,
        newExpiresAt: newExpiresAt.toISOString(),
      },
      'system'
    );
  }

  /**
   * Emergency revoke a key (immediate invalidation)
   */
  async revokeKey(keyId: string, reason: string): Promise<void> {
    if (!this.initialized) await this.initialize();

    const key = this.registry!.keys.find((k) => k.id === keyId);
    if (!key) {
      throw new Error(`Key not found: ${keyId}`);
    }

    const now = new Date();

    key.status = 'revoked';
    key.revokedAt = now.toISOString();
    key.revocationReason = reason;

    if (this.registry!.activeKeyId === keyId) {
      this.registry!.activeKeyId = null;
    }

    await this.saveRegistry();

    await this.config.auditLogger?.log(
      'key_revoked',
      {
        keyId,
        reason,
        timestamp: now.toISOString(),
      },
      'system'
    );

    console.warn(`[key-manager] KEY REVOKED: ${keyId} - ${reason}`);
  }

  /**
   * Get all keys valid for verification (active + non-expired retired)
   */
  getVerificationKeys(): KeyInfo[] {
    if (!this.registry) return [];

    const now = new Date();

    return this.registry.keys.filter((key) => {
      if (key.status === 'revoked') return false;
      if (new Date(key.expiresAt) < now) return false;
      return true;
    });
  }

  /**
   * Get the active signing key
   */
  getActiveKey(): KeyInfo | null {
    if (!this.registry || !this.registry.activeKeyId) return null;

    const key = this.registry.keys.find(
      (k) => k.id === this.registry!.activeKeyId
    );

    if (!key || key.status !== 'active') return null;

    // Check if expired
    if (new Date(key.expiresAt) < new Date()) {
      return null;
    }

    return key;
  }

  /**
   * Check if a key ID is valid for verification
   */
  isKeyValidForVerification(keyId: string): boolean {
    return this.getVerificationKeys().some((k) => k.id === keyId);
  }

  /**
   * Get key by ID
   */
  getKeyById(keyId: string): KeyInfo | null {
    if (!this.registry) return null;
    return this.registry.keys.find((k) => k.id === keyId) || null;
  }

  /**
   * Check if rotation is needed
   */
  needsRotation(): boolean {
    const activeKey = this.getActiveKey();
    if (!activeKey) return true;

    const expiresAt = new Date(activeKey.expiresAt);
    const now = new Date();
    const daysUntilExpiry = Math.ceil(
      (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Rotate when within overlap period
    return daysUntilExpiry <= this.config.overlapDays;
  }

  /**
   * Perform automatic rotation if needed
   */
  async rotateIfNeeded(): Promise<{
    rotated: boolean;
    keyId?: string;
  }> {
    if (!this.needsRotation()) {
      return { rotated: false };
    }

    const result = await this.generateKey();
    return { rotated: true, keyId: result.keyId };
  }

  /**
   * Clean up old retired keys beyond the retention limit
   */
  private async cleanupRetiredKeys(): Promise<void> {
    if (!this.registry) return;

    const retiredKeys = this.registry.keys
      .filter((k) => k.status === 'retired')
      .sort(
        (a, b) =>
          new Date(b.retiredAt!).getTime() - new Date(a.retiredAt!).getTime()
      );

    const keysToRemove = retiredKeys.slice(this.config.maxRetiredKeys);

    for (const key of keysToRemove) {
      const index = this.registry.keys.findIndex((k) => k.id === key.id);
      if (index !== -1) {
        this.registry.keys.splice(index, 1);

        await this.config.auditLogger?.log(
          'key_cleaned_up',
          {
            keyId: key.id,
            reason: 'exceeded_retention_limit',
          },
          'system'
        );
      }
    }

    if (keysToRemove.length > 0) {
      await this.saveRegistry();
    }
  }

  /**
   * Compute key ID from public key (first 8 bytes of SHA-256)
   */
  private computeKeyId(publicKey: Uint8Array): string {
    const hash = createHash('sha256').update(publicKey).digest();
    return hash.subarray(0, 8).toString('hex');
  }

  /**
   * Get registry status summary
   */
  getStatus(): {
    activeKeyId: string | null;
    activeKeyExpires: string | null;
    totalKeys: number;
    verificationKeys: number;
    needsRotation: boolean;
  } {
    const activeKey = this.getActiveKey();
    const verificationKeys = this.getVerificationKeys();

    return {
      activeKeyId: this.registry?.activeKeyId || null,
      activeKeyExpires: activeKey?.expiresAt || null,
      totalKeys: this.registry?.keys.length || 0,
      verificationKeys: verificationKeys.length,
      needsRotation: this.needsRotation(),
    };
  }

  /**
   * Export public keys for external verification (e.g., webhook consumers)
   */
  exportPublicKeys(): Array<{ id: string; publicKey: string; status: string }> {
    return this.getVerificationKeys().map((k) => ({
      id: k.id,
      publicKey: k.publicKey,
      status: k.status,
    }));
  }

  /**
   * Import a retired key for verification (e.g., from environment variable)
   */
  async importRetiredKey(
    keyId: string,
    publicKeyHex: string,
    expiresAt: Date
  ): Promise<void> {
    if (!this.initialized) await this.initialize();

    // Check if already exists
    if (this.registry!.keys.some((k) => k.id === keyId)) {
      console.log(`[key-manager] Key ${keyId} already in registry`);
      return;
    }

    const keyInfo: KeyInfo = {
      id: keyId,
      publicKey: publicKeyHex,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: 'retired',
      retiredAt: new Date().toISOString(),
    };

    this.registry!.keys.push(keyInfo);
    await this.saveRegistry();

    await this.config.auditLogger?.log(
      'key_imported',
      {
        keyId,
        expiresAt: expiresAt.toISOString(),
      },
      'system'
    );
  }

  /**
   * Get the registry path
   */
  getRegistryPath(): string {
    return this.config.registryPath;
  }
}

/**
 * Create a KeyManager with default configuration
 */
export function createKeyManager(
  registryPath: string,
  auditLogger?: AuditLogger
): KeyManager {
  return new KeyManager({
    registryPath,
    rotationDays: 90,
    overlapDays: 7,
    maxRetiredKeys: 3,
    auditLogger,
  });
}

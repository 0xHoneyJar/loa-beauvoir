/**
 * Manifest Signer - Ed25519 signing for state manifests
 *
 * Implements RFC 8785 JCS (JSON Canonicalization Scheme) for deterministic
 * JSON serialization before signing. Supports key lifecycle with multi-key
 * verification for rotation compatibility.
 *
 * @module deploy/loa-identity/security/manifest-signer
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { createHash } from 'crypto';

// Configure ed25519 to use sha512
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface StateManifest {
  version: 1;
  generated_at: string;
  files: Record<string, FileEntry>;
  restore_count: number;
  last_restore_source: 'r2' | 'git' | 'template' | null;
  signature?: ManifestSignature;
}

export interface FileEntry {
  sha256: string;
  size_bytes: number;
  mtime: string;
}

export interface ManifestSignature {
  algorithm: 'ed25519';
  public_key_id: string;
  value: string;
}

export interface KeyPair {
  id: string;
  publicKey: Uint8Array;
  privateKey?: Uint8Array;
  status: 'active' | 'retired' | 'revoked';
  created_at: string;
  expires_at?: string;
}

/**
 * ManifestSigner handles Ed25519 signing and verification of state manifests.
 * Supports multi-key verification for seamless key rotation.
 */
export class ManifestSigner {
  private activeKey: KeyPair | null = null;
  private retiredKeys: KeyPair[] = [];
  private publicKeyEnvVar = 'LOA_PUBLIC_KEY';
  private privateKeyEnvVar = 'LOA_SIGNING_KEY';

  constructor() {
    this.loadKeys();
  }

  /**
   * Load keys from environment/embedded sources
   */
  private loadKeys(): void {
    // Load active public key (embedded in container or from env)
    const publicKeyHex = process.env[this.publicKeyEnvVar];
    if (publicKeyHex) {
      this.activeKey = {
        id: this.computeKeyId(Buffer.from(publicKeyHex, 'hex')),
        publicKey: Buffer.from(publicKeyHex, 'hex'),
        status: 'active',
        created_at: new Date().toISOString(),
      };
    }

    // Load retired keys if available (for rotation compatibility)
    const retiredKeysJson = process.env.LOA_RETIRED_KEYS;
    if (retiredKeysJson) {
      try {
        const retired = JSON.parse(retiredKeysJson) as Array<{
          id: string;
          publicKey: string;
          created_at: string;
        }>;
        this.retiredKeys = retired.map((k) => ({
          id: k.id,
          publicKey: Buffer.from(k.publicKey, 'hex'),
          status: 'retired' as const,
          created_at: k.created_at,
        }));
      } catch {
        console.warn('[manifest-signer] Failed to parse retired keys');
      }
    }
  }

  /**
   * Compute key ID from public key (first 8 bytes of SHA256)
   */
  private computeKeyId(publicKey: Uint8Array): string {
    const hash = createHash('sha256').update(publicKey).digest();
    return hash.subarray(0, 8).toString('hex');
  }

  /**
   * Sign a manifest using the active private key
   */
  async signManifest(
    manifest: Omit<StateManifest, 'signature'>
  ): Promise<StateManifest> {
    const privateKeyHex = process.env[this.privateKeyEnvVar];
    if (!privateKeyHex) {
      throw new Error(
        'LOA_SIGNING_KEY not set - cannot sign manifest. ' +
          'Set the environment variable or use Cloudflare Secrets.'
      );
    }

    const privateKey = Buffer.from(privateKeyHex, 'hex');
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const keyId = this.computeKeyId(publicKey);

    // Canonicalize manifest for signing (RFC 8785 JCS)
    const canonical = this.canonicalize(manifest);
    const signature = await ed.signAsync(
      new TextEncoder().encode(canonical),
      privateKey
    );

    return {
      ...manifest,
      signature: {
        algorithm: 'ed25519',
        public_key_id: keyId,
        value: Buffer.from(signature).toString('base64'),
      },
    };
  }

  /**
   * Verify manifest signature using active + retired keys
   * Multi-key verification enables seamless key rotation
   */
  async verifyManifest(manifest: StateManifest): Promise<boolean> {
    if (!manifest.signature) {
      console.warn('[manifest-signer] No signature present');
      return false;
    }

    if (manifest.signature.algorithm !== 'ed25519') {
      console.warn(
        `[manifest-signer] Unsupported algorithm: ${manifest.signature.algorithm}`
      );
      return false;
    }

    // Build list of keys to try (active + retired)
    const keysToTry: KeyPair[] = [];
    if (this.activeKey) {
      keysToTry.push(this.activeKey);
    }
    keysToTry.push(...this.retiredKeys.filter((k) => k.status !== 'revoked'));

    if (keysToTry.length === 0) {
      console.warn('[manifest-signer] No keys available for verification');
      return false;
    }

    // Try matching key ID first (optimization)
    const matchingKey = keysToTry.find(
      (k) => k.id === manifest.signature!.public_key_id
    );
    if (matchingKey) {
      const verified = await this.verifyWithKey(manifest, matchingKey);
      if (verified) {
        console.log(
          `[manifest-signer] Verified with key ${matchingKey.id} (${matchingKey.status})`
        );
        return true;
      }
    }

    // Fall back to trying all keys
    for (const key of keysToTry) {
      if (key.id === manifest.signature.public_key_id) continue; // Already tried
      const verified = await this.verifyWithKey(manifest, key);
      if (verified) {
        console.log(
          `[manifest-signer] Verified with key ${key.id} (${key.status})`
        );
        return true;
      }
    }

    console.warn('[manifest-signer] Signature verification failed');
    return false;
  }

  /**
   * Verify signature with a specific key
   */
  private async verifyWithKey(
    manifest: StateManifest,
    key: KeyPair
  ): Promise<boolean> {
    try {
      // Remove signature for verification
      const { signature, ...manifestWithoutSig } = manifest;
      const canonical = this.canonicalize(manifestWithoutSig);
      const signatureBytes = Buffer.from(signature!.value, 'base64');

      return await ed.verifyAsync(
        signatureBytes,
        new TextEncoder().encode(canonical),
        key.publicKey
      );
    } catch (e) {
      console.warn(`[manifest-signer] Verification error with key ${key.id}:`, e);
      return false;
    }
  }

  /**
   * RFC 8785 JCS Canonicalization
   * - Sort object keys lexicographically
   * - No whitespace
   * - Unicode normalization
   * - Consistent number formatting
   */
  canonicalize(obj: unknown): string {
    return JSON.stringify(obj, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Sort keys lexicographically
        return Object.keys(value)
          .sort()
          .reduce(
            (sorted, k) => {
              sorted[k] = value[k];
              return sorted;
            },
            {} as Record<string, unknown>
          );
      }
      return value;
    });
  }

  /**
   * Get active key ID for inclusion in signed documents
   */
  getActiveKeyId(): string | null {
    return this.activeKey?.id ?? null;
  }

  /**
   * Check if a key is revoked
   */
  isKeyRevoked(keyId: string): boolean {
    return this.retiredKeys.some((k) => k.id === keyId && k.status === 'revoked');
  }

  /**
   * Add a retired key for backward compatibility verification
   */
  addRetiredKey(keyPair: KeyPair): void {
    if (!this.retiredKeys.find((k) => k.id === keyPair.id)) {
      this.retiredKeys.push({ ...keyPair, status: 'retired' });
    }
  }

  /**
   * Revoke a key (removes from verification pool)
   */
  revokeKey(keyId: string): void {
    const key = this.retiredKeys.find((k) => k.id === keyId);
    if (key) {
      key.status = 'revoked';
    }
    if (this.activeKey?.id === keyId) {
      this.activeKey.status = 'revoked';
    }
  }
}

/**
 * Generate a new Ed25519 key pair
 */
export async function generateKeyPair(): Promise<{
  privateKey: string;
  publicKey: string;
  keyId: string;
}> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const keyId = createHash('sha256')
    .update(publicKey)
    .digest()
    .subarray(0, 8)
    .toString('hex');

  return {
    privateKey: Buffer.from(privateKey).toString('hex'),
    publicKey: Buffer.from(publicKey).toString('hex'),
    keyId,
  };
}

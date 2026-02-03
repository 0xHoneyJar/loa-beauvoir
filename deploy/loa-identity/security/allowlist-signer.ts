/**
 * Allowlist Signer - Ed25519 signing for package allowlists
 *
 * Provides cryptographic verification for self-repair allowlists to prevent
 * supply chain attacks. Unsigned or tampered allowlists are rejected.
 *
 * @module deploy/loa-identity/security/allowlist-signer
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import * as yaml from 'yaml';

// Configure ed25519 to use sha512
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export interface PackageSpec {
  name: string;
  version: string;
  sha256: string;
  lockfile?: string;
}

export interface PackageAllowlist {
  version: number;
  npm: PackageSpec[];
  apt: PackageSpec[];
  commands?: string[];
}

export interface SignedPackageAllowlist extends PackageAllowlist {
  signature: {
    algorithm: 'ed25519';
    public_key_id: string;
    value: string;
    signed_at: string;
  };
}

/**
 * AllowlistSigner handles Ed25519 signing and verification of package allowlists.
 * Rejects any unsigned or tampered allowlists to prevent supply chain attacks.
 */
export class AllowlistSigner {
  private publicKeyEnvVar = 'LOA_PUBLIC_KEY';
  private privateKeyEnvVar = 'LOA_SIGNING_KEY';

  /**
   * Sign an allowlist using the active private key
   */
  async signAllowlist(
    allowlist: PackageAllowlist
  ): Promise<SignedPackageAllowlist> {
    const privateKeyHex = process.env[this.privateKeyEnvVar];
    if (!privateKeyHex) {
      throw new Error(
        'LOA_SIGNING_KEY not set - cannot sign allowlist. ' +
          'Set the environment variable or use Cloudflare Secrets.'
      );
    }

    const privateKey = Buffer.from(privateKeyHex, 'hex');
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const keyId = this.computeKeyId(publicKey);

    // Canonicalize for signing
    const canonical = this.canonicalize(allowlist);
    const signature = await ed.signAsync(
      new TextEncoder().encode(canonical),
      privateKey
    );

    return {
      ...allowlist,
      signature: {
        algorithm: 'ed25519',
        public_key_id: keyId,
        value: Buffer.from(signature).toString('base64'),
        signed_at: new Date().toISOString(),
      },
    };
  }

  /**
   * Verify allowlist signature
   * Returns false for unsigned, tampered, or invalid signatures
   */
  async verifyAllowlist(allowlist: SignedPackageAllowlist): Promise<boolean> {
    if (!allowlist.signature) {
      console.warn('[allowlist-signer] No signature present - REJECTING');
      return false;
    }

    if (allowlist.signature.algorithm !== 'ed25519') {
      console.warn(
        `[allowlist-signer] Unsupported algorithm: ${allowlist.signature.algorithm}`
      );
      return false;
    }

    const publicKeyHex = process.env[this.publicKeyEnvVar];
    if (!publicKeyHex) {
      console.warn('[allowlist-signer] No public key available for verification');
      return false;
    }

    const publicKey = Buffer.from(publicKeyHex, 'hex');
    const expectedKeyId = this.computeKeyId(publicKey);

    // Verify key ID matches (prevents using old/different keys)
    if (allowlist.signature.public_key_id !== expectedKeyId) {
      // Check if it's a retired key that's still valid
      const retiredKeysJson = process.env.LOA_RETIRED_KEYS;
      if (retiredKeysJson) {
        try {
          const retired = JSON.parse(retiredKeysJson) as Array<{
            id: string;
            publicKey: string;
          }>;
          const matchingKey = retired.find(
            (k) => k.id === allowlist.signature.public_key_id
          );
          if (matchingKey) {
            return this.verifyWithKey(
              allowlist,
              Buffer.from(matchingKey.publicKey, 'hex')
            );
          }
        } catch {
          // Fall through to rejection
        }
      }

      console.warn(
        `[allowlist-signer] Key ID mismatch: expected ${expectedKeyId}, got ${allowlist.signature.public_key_id}`
      );
      return false;
    }

    return this.verifyWithKey(allowlist, publicKey);
  }

  /**
   * Verify signature with a specific public key
   */
  private async verifyWithKey(
    allowlist: SignedPackageAllowlist,
    publicKey: Uint8Array
  ): Promise<boolean> {
    try {
      // Remove signature for verification
      const { signature, ...allowlistWithoutSig } = allowlist;
      const canonical = this.canonicalize(allowlistWithoutSig);
      const signatureBytes = Buffer.from(signature.value, 'base64');

      const verified = await ed.verifyAsync(
        signatureBytes,
        new TextEncoder().encode(canonical),
        publicKey
      );

      if (!verified) {
        console.warn('[allowlist-signer] Signature verification failed - REJECTING');
      }

      return verified;
    } catch (e) {
      console.warn('[allowlist-signer] Verification error:', e);
      return false;
    }
  }

  /**
   * Compute key ID from public key
   */
  private computeKeyId(publicKey: Uint8Array): string {
    const hash = createHash('sha256').update(publicKey).digest();
    return hash.subarray(0, 8).toString('hex');
  }

  /**
   * RFC 8785 JCS Canonicalization
   */
  private canonicalize(obj: unknown): string {
    return JSON.stringify(obj, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
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
   * Load and verify allowlist from file
   */
  async loadAllowlist(path: string): Promise<SignedPackageAllowlist> {
    const content = await readFile(path, 'utf-8');
    const allowlist = yaml.parse(content) as SignedPackageAllowlist;

    const verified = await this.verifyAllowlist(allowlist);
    if (!verified) {
      throw new Error(
        `Allowlist signature verification failed: ${path}. ` +
          'Self-repair is disabled until a valid signed allowlist is provided.'
      );
    }

    return allowlist;
  }

  /**
   * Sign and save allowlist to file
   */
  async saveAllowlist(
    allowlist: PackageAllowlist,
    path: string
  ): Promise<void> {
    const signed = await this.signAllowlist(allowlist);
    const yamlContent = yaml.stringify(signed);
    await writeFile(path, yamlContent, 'utf-8');
  }

  /**
   * Check if a package is in the allowlist
   */
  isPackageAllowed(
    allowlist: SignedPackageAllowlist,
    type: 'npm' | 'apt',
    name: string,
    version?: string
  ): PackageSpec | null {
    const packages = type === 'npm' ? allowlist.npm : allowlist.apt;
    const found = packages.find((p) => p.name === name);

    if (!found) return null;

    // Check version if specified
    if (version && found.version !== '*') {
      // Support semver wildcards (e.g., "10.*")
      if (found.version.includes('*')) {
        const pattern = found.version.replace(/\*/g, '.*');
        const regex = new RegExp(`^${pattern}$`);
        if (!regex.test(version)) return null;
      } else if (found.version !== version) {
        return null;
      }
    }

    return found;
  }

  /**
   * Check if a command is in the explicit command allowlist
   */
  isCommandAllowed(allowlist: SignedPackageAllowlist, command: string): boolean {
    if (!allowlist.commands) return false;
    return allowlist.commands.some((c) => command.startsWith(c));
  }
}

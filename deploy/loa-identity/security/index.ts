/**
 * Security Module - Cryptographic signing, PII redaction, and audit logging
 *
 * @module deploy/loa-identity/security
 */

export { AuditLogger, type AuditEntry, type AuditLoggerConfig, type VerificationError } from './audit-logger.js';

export {
  ManifestSigner,
  generateKeyPair,
  type StateManifest,
  type FileEntry,
  type ManifestSignature,
  type KeyPair,
} from './manifest-signer.js';

export {
  AllowlistSigner,
  type PackageSpec,
  type PackageAllowlist,
  type SignedPackageAllowlist,
} from './allowlist-signer.js';

export {
  CredentialManager,
  getCredentialManager,
  type R2Credentials,
  type SigningCredentials,
  type CredentialSource,
} from './credential-manager.js';

export {
  KeyManager,
  createKeyManager,
  type KeyInfo,
  type KeyRegistry,
  type KeyManagerConfig,
} from './key-manager.js';

export {
  PIIRedactor,
  type RedactionResult,
  type RedactionRecord,
  type PatternSpec,
  type PIIRedactorConfig,
} from './pii-redactor.js';

export {
  SecretScanner,
  runPreCommitHook,
  type ScanResult,
  type SecretFinding,
} from './secret-scanner.js';

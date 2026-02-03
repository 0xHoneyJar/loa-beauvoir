# Key Compromise Response Runbook

## Overview

This runbook provides step-by-step procedures for responding to a suspected or confirmed compromise of Loa's Ed25519 signing keys.

**Severity:** Critical
**Response Time:** Immediate (within 1 hour of detection)
**Escalation:** Security Team Lead, Platform Lead

---

## Detection Triggers

### Automatic Alerts
- Signature verification failures spike
- Unknown key IDs in verification requests
- Audit log integrity check failures
- Anomalous signing activity patterns

### Manual Discovery
- Unauthorized commits with valid signatures
- Reports of spoofed state manifests
- Credential exposure in logs or repos
- Third-party security disclosure

---

## Immediate Response (0-15 minutes)

### Step 1: Confirm the Compromise

```bash
# Check audit logs for suspicious activity
tail -100 /var/log/loa/audit.log | grep -E "(key_|sign|verify)"

# Verify current key status
node -e "
import { createKeyManager } from './deploy/loa-identity/security/key-manager.js';
const km = createKeyManager('/var/lib/loa/keys/registry.yaml');
await km.initialize();
console.log(km.getStatus());
"
```

**Decision Point:**
- If confirmed compromise → Continue to Step 2
- If false positive → Document and close incident

### Step 2: Revoke Compromised Key

```bash
# Identify the compromised key ID
COMPROMISED_KEY_ID="<key-id-here>"
REASON="Suspected key compromise - $(date -u +%Y%m%d-%H%M%S)"

# Revoke via KeyManager
node -e "
import { createKeyManager } from './deploy/loa-identity/security/key-manager.js';
const km = createKeyManager('/var/lib/loa/keys/registry.yaml');
await km.initialize();
await km.revokeKey('$COMPROMISED_KEY_ID', '$REASON');
console.log('Key revoked:', km.getKeyById('$COMPROMISED_KEY_ID'));
"
```

### Step 3: Generate New Key

```bash
# Generate new signing key
./scripts/generate-signing-keys.sh --json > /tmp/new-key.json

# Store in Cloudflare Secrets (production)
cat /tmp/new-key.json | jq -r '.privateKey' | wrangler secret put LOA_SIGNING_KEY
cat /tmp/new-key.json | jq -r '.publicKey' | wrangler secret put LOA_PUBLIC_KEY

# Secure delete temporary file
shred -u /tmp/new-key.json
```

---

## Containment (15-60 minutes)

### Step 4: Invalidate All Sessions

```bash
# Force re-verification of all active state manifests
node -e "
import { R2StateStore } from './deploy/loa-identity/persistence/r2-state-store.js';
const store = new R2StateStore();
await store.invalidateAllManifests();
"
```

### Step 5: Re-sign Critical Allowlists

```bash
# Re-sign package allowlists with new key
node -e "
import { AllowlistSigner } from './deploy/loa-identity/security/allowlist-signer.js';
const signer = new AllowlistSigner();
await signer.loadAllowlist('./deploy/loa-identity/config/package-allowlist.yaml')
  .catch(() => console.log('Re-signing required'));
"
```

### Step 6: Notify Dependent Services

**Internal:**
- [ ] Alert platform team via Slack #loa-incidents
- [ ] Update status page (if applicable)
- [ ] Notify CI/CD pipelines to use new keys

**External (if keys were used for external verification):**
- [ ] Publish new public key to verification endpoints
- [ ] Notify webhook consumers of key rotation
- [ ] Update documentation with new key ID

---

## Investigation (1-4 hours)

### Step 7: Determine Scope

```bash
# Search for leaked keys in logs
grep -r "LOA_SIGNING_KEY\|LOA_PUBLIC_KEY" /var/log/

# Check git history for accidental commits
git log --all --full-history -- "**/.*env*" "**/*.key"

# Review Cloudflare access logs
wrangler tail --format=json | grep -i "secret"
```

### Step 8: Identify Attack Vector

**Common vectors to investigate:**
1. **Log exposure** - Keys printed to stdout/logs
2. **Version control** - Committed to git
3. **Environment leak** - Debug endpoints, error pages
4. **Supply chain** - Compromised dependency
5. **Insider threat** - Unauthorized access
6. **Infrastructure** - Server/container breach

### Step 9: Audit Signed Content

```bash
# List all content signed with compromised key
node -e "
import { AuditLogger } from './deploy/loa-identity/security/audit-logger.js';
const logger = new AuditLogger('/var/log/loa/audit.log');
const entries = await logger.searchByAction('manifest_signed');
const suspicious = entries.filter(e =>
  e.details.keyId === '$COMPROMISED_KEY_ID' &&
  new Date(e.timestamp) > new Date('$COMPROMISE_WINDOW_START')
);
console.log(JSON.stringify(suspicious, null, 2));
"
```

---

## Recovery (4-24 hours)

### Step 10: Restore State Integrity

```bash
# Verify and re-sign all state manifests
node scripts/verify-all-manifests.js --resign-if-invalid

# Verify audit log chain integrity
node -e "
import { AuditLogger } from './deploy/loa-identity/security/audit-logger.js';
const logger = new AuditLogger('/var/log/loa/audit.log');
const result = await logger.verify();
console.log('Audit log integrity:', result);
"
```

### Step 11: Update Key Rotation Schedule

If compromise indicates key management weakness:

```yaml
# Update rotation policy in key-registry.yaml
rotationPolicy:
  rotationDays: 30    # Reduced from 90
  overlapDays: 3      # Reduced from 7
  maxRetiredKeys: 2   # Reduced from 3
```

### Step 12: Implement Additional Controls

Based on root cause, implement:

- [ ] Enhanced audit logging for key operations
- [ ] Key access monitoring/alerting
- [ ] HSM integration for key storage
- [ ] Reduced key permissions/scope
- [ ] Additional signature verification points

---

## Post-Incident (24-72 hours)

### Step 13: Create Incident Report

Document:
1. Timeline of events
2. Detection method
3. Response actions taken
4. Root cause analysis
5. Impact assessment
6. Lessons learned
7. Action items

### Step 14: Update Security Controls

- [ ] Review and update this runbook
- [ ] Add detection for discovered attack vector
- [ ] Implement compensating controls
- [ ] Schedule security review

### Step 15: Communicate Resolution

**Internal:**
- Post incident summary to #loa-incidents
- Update ticket/issue tracker
- Brief security team lead

**External (if applicable):**
- Update status page
- Notify affected parties
- Publish security advisory if required

---

## Quick Reference

### Key Locations

| Item | Location |
|------|----------|
| Key Registry | `/var/lib/loa/keys/registry.yaml` |
| Audit Log | `/var/log/loa/audit.log` |
| Signing Key | Cloudflare Secret: `LOA_SIGNING_KEY` |
| Public Key | Cloudflare Secret: `LOA_PUBLIC_KEY` |
| Retired Keys | Environment: `LOA_RETIRED_KEYS` (JSON array) |

### Emergency Contacts

| Role | Contact |
|------|---------|
| Security Lead | [REDACTED] |
| Platform Lead | [REDACTED] |
| On-Call | [REDACTED] |

### Related Runbooks

- [R2 State Recovery](./r2-state-recovery.md)
- [Audit Log Restoration](./audit-log-restoration.md)
- [Self-Repair Lockdown](./self-repair-lockdown.md)

---

## Appendix: Key Revocation Command Summary

```bash
# Quick revocation (copy-paste ready)
export COMPROMISED_KEY_ID="<key-id>"
export REASON="Emergency revocation - $(date -u +%Y%m%dT%H%M%SZ)"

node -e "
import { createKeyManager } from './deploy/loa-identity/security/key-manager.js';
const km = createKeyManager('/var/lib/loa/keys/registry.yaml');
await km.initialize();
await km.revokeKey(process.env.COMPROMISED_KEY_ID, process.env.REASON);
console.log('✓ Key revoked');
console.log(km.getStatus());
"
```

---

*Last Updated: 2026-02-03*
*Version: 1.0.0*
*Owner: Loa Security Team*

/**
 * Vendored validation for beads-bridge.
 *
 * Subset of .claude/lib/beads/validation.ts — kept in sync manually.
 * Bridge only needs bead ID + label validation and label helpers.
 *
 * SECURITY: All user-controllable values MUST be validated before
 * use in shell commands or file paths.
 */

// -- Constants ----------------------------------------------------------------

export const BEAD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const MAX_BEAD_ID_LENGTH = 128;

export const LABEL_PATTERN = /^[a-zA-Z0-9_:-]+$/;
export const MAX_LABEL_LENGTH = 64;

export const MAX_COMMENT_LENGTH = 1024;

// -- Validators ---------------------------------------------------------------

export function validateBeadId(beadId: unknown): asserts beadId is string {
  if (!beadId || typeof beadId !== "string") {
    throw new Error("Invalid beadId: must be a non-empty string");
  }
  if (!BEAD_ID_PATTERN.test(beadId)) {
    throw new Error(
      `Invalid beadId: must match pattern ${BEAD_ID_PATTERN} (alphanumeric, underscore, hyphen only)`,
    );
  }
  if (beadId.length > MAX_BEAD_ID_LENGTH) {
    throw new Error(`Invalid beadId: exceeds maximum length of ${MAX_BEAD_ID_LENGTH} characters`);
  }
}

export function validateLabel(label: unknown): asserts label is string {
  if (!label || typeof label !== "string") {
    throw new Error("Invalid label: must be a non-empty string");
  }
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `Invalid label: must match pattern ${LABEL_PATTERN} (alphanumeric, underscore, hyphen, colon)`,
    );
  }
  if (label.length > MAX_LABEL_LENGTH) {
    throw new Error(`Invalid label: exceeds maximum length of ${MAX_LABEL_LENGTH} characters`);
  }
}

// -- Label helpers ------------------------------------------------------------

export function hasLabel(labels: readonly string[], target: string): boolean {
  return labels.includes(target);
}

export function getLabelsWithPrefix(labels: readonly string[], prefix: string): string[] {
  return labels.filter((l) => l.startsWith(prefix));
}

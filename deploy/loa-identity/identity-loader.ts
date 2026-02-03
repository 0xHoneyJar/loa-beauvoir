/**
 * Identity Loader - Parse and manage BEAUVOIR.md identity document
 *
 * Loads the personality definition, principles, and boundaries from
 * the BEAUVOIR.md file. Tracks changes to NOTES.md.
 *
 * @module deploy/loa-identity/identity-loader
 */

import { readFile, appendFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

export interface Principle {
  id: number;
  name: string;
  description: string;
  inPractice?: string;
}

export interface Boundary {
  type: 'will_not' | 'always';
  items: string[];
}

export interface IdentityDocument {
  version: string;
  lastUpdated: string;
  corePrinciples: Principle[];
  boundaries: Boundary[];
  interactionStyle: string[];
  recoveryProtocol: string;
  checksum: string;
}

export interface IdentityLoaderConfig {
  beauvoirPath: string;
  notesPath: string;
}

/**
 * IdentityLoader parses BEAUVOIR.md and manages identity state.
 */
export class IdentityLoader {
  private config: IdentityLoaderConfig;
  private identity: IdentityDocument | null = null;
  private lastLoadedChecksum: string | null = null;

  constructor(config: IdentityLoaderConfig) {
    this.config = config;
  }

  /**
   * Load identity from BEAUVOIR.md
   */
  async load(): Promise<IdentityDocument> {
    if (!existsSync(this.config.beauvoirPath)) {
      throw new Error(`BEAUVOIR.md not found at ${this.config.beauvoirPath}`);
    }

    const content = await readFile(this.config.beauvoirPath, 'utf-8');
    const checksum = this.computeChecksum(content);

    // Check if document changed since last load
    if (this.lastLoadedChecksum && this.lastLoadedChecksum !== checksum) {
      await this.logIdentityChange(checksum);
    }

    const identity = this.parseDocument(content, checksum);
    this.identity = identity;
    this.lastLoadedChecksum = checksum;

    return identity;
  }

  /**
   * Parse BEAUVOIR.md content
   */
  private parseDocument(content: string, checksum: string): IdentityDocument {
    const lines = content.split('\n');

    // Extract version from header
    const versionMatch = content.match(/\*\*Version\*\*:\s*(\S+)/);
    const version = versionMatch?.[1] ?? '0.0.0';

    // Extract last updated
    const updatedMatch = content.match(/\*\*Last Updated\*\*:\s*(\S+)/);
    const lastUpdated = updatedMatch?.[1] ?? new Date().toISOString().split('T')[0];

    // Parse principles
    const principles = this.parsePrinciples(content);

    // Parse boundaries
    const boundaries = this.parseBoundaries(content);

    // Parse interaction style
    const interactionStyle = this.parseInteractionStyle(content);

    // Extract recovery protocol
    const recoveryProtocol = this.parseRecoveryProtocol(content);

    return {
      version,
      lastUpdated,
      corePrinciples: principles,
      boundaries,
      interactionStyle,
      recoveryProtocol,
      checksum,
    };
  }

  /**
   * Parse core principles section
   */
  private parsePrinciples(content: string): Principle[] {
    const principles: Principle[] = [];

    // Match principle headers like "### 1. Understand Before Acting"
    const principleRegex = /###\s*(\d+)\.\s*([^\n]+)\n\n([^#]+?)(?=###|\n---|\n##|$)/g;
    let match;

    while ((match = principleRegex.exec(content)) !== null) {
      const id = parseInt(match[1], 10);
      const name = match[2].trim();
      const body = match[3].trim();

      // Extract "In practice:" section if present
      const inPracticeMatch = body.match(/\*\*In practice\*\*:\s*([^*]+)/);
      const inPractice = inPracticeMatch?.[1]?.trim();

      // Get main description (before "In practice")
      let description = body;
      if (inPracticeMatch) {
        description = body.substring(0, body.indexOf('**In practice**')).trim();
      }

      // Clean up markdown bold markers for principle explanation
      const explanationMatch = description.match(/\*\*([^*]+)\*\*/);
      if (explanationMatch) {
        description = explanationMatch[1];
      }

      principles.push({
        id,
        name,
        description,
        inPractice,
      });
    }

    return principles;
  }

  /**
   * Parse boundaries section
   */
  private parseBoundaries(content: string): Boundary[] {
    const boundaries: Boundary[] = [];

    // Find "What I Won't Do" section
    const willNotMatch = content.match(/###\s*What I Won't Do\n\n([\s\S]*?)(?=###|---|##|$)/);
    if (willNotMatch) {
      const items = this.parseListItems(willNotMatch[1]);
      if (items.length > 0) {
        boundaries.push({ type: 'will_not', items });
      }
    }

    // Find "What I Always Do" section
    const alwaysMatch = content.match(/###\s*What I Always Do\n\n([\s\S]*?)(?=###|---|##|$)/);
    if (alwaysMatch) {
      const items = this.parseListItems(alwaysMatch[1]);
      if (items.length > 0) {
        boundaries.push({ type: 'always', items });
      }
    }

    return boundaries;
  }

  /**
   * Parse interaction style section
   */
  private parseInteractionStyle(content: string): string[] {
    const styles: string[] = [];

    const styleMatch = content.match(/##\s*Interaction Style\n\n([\s\S]*?)(?=##|---|$)/);
    if (styleMatch) {
      // Extract style headers (### Concise, ### Opinionated, etc.)
      const styleRegex = /###\s*([^\n]+)/g;
      let match;
      while ((match = styleRegex.exec(styleMatch[1])) !== null) {
        styles.push(match[1].trim());
      }
    }

    return styles;
  }

  /**
   * Parse recovery protocol section
   */
  private parseRecoveryProtocol(content: string): string {
    const protocolMatch = content.match(/##\s*Recovery Protocol\n\n([\s\S]*?)(?=##|---|$)/);
    if (protocolMatch) {
      // Extract the code block
      const codeMatch = protocolMatch[1].match(/```([\s\S]*?)```/);
      if (codeMatch) {
        return codeMatch[1].trim();
      }
    }
    return '';
  }

  /**
   * Parse numbered or bulleted list items
   */
  private parseListItems(text: string): string[] {
    const items: string[] = [];
    const listRegex = /^\s*(?:\d+\.|[-*])\s*\*\*([^*]+)\*\*\s*[-–]?\s*(.*)$/gm;
    let match;

    while ((match = listRegex.exec(text)) !== null) {
      const title = match[1].trim();
      const description = match[2].trim();
      items.push(description ? `${title}: ${description}` : title);
    }

    return items;
  }

  /**
   * Log identity change to NOTES.md
   */
  private async logIdentityChange(newChecksum: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const logEntry = `\n## [Identity Change] ${timestamp}\n\n- Previous checksum: ${this.lastLoadedChecksum}\n- New checksum: ${newChecksum}\n- Document reloaded\n`;

    try {
      if (existsSync(this.config.notesPath)) {
        await appendFile(this.config.notesPath, logEntry, 'utf-8');
      }
    } catch (e) {
      console.warn('[identity-loader] Failed to log identity change:', e);
    }
  }

  /**
   * Compute SHA-256 checksum of content
   */
  private computeChecksum(content: string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Get loaded identity
   */
  getIdentity(): IdentityDocument | null {
    return this.identity;
  }

  /**
   * Get specific principle by ID
   */
  getPrinciple(id: number): Principle | undefined {
    return this.identity?.corePrinciples.find((p) => p.id === id);
  }

  /**
   * Get all boundaries of a specific type
   */
  getBoundaries(type: 'will_not' | 'always'): string[] {
    const boundary = this.identity?.boundaries.find((b) => b.type === type);
    return boundary?.items ?? [];
  }

  /**
   * Check if identity document has changed on disk
   */
  async hasChanged(): Promise<boolean> {
    if (!existsSync(this.config.beauvoirPath)) {
      return true;
    }

    const content = await readFile(this.config.beauvoirPath, 'utf-8');
    const checksum = this.computeChecksum(content);

    return checksum !== this.lastLoadedChecksum;
  }

  /**
   * Get document stats
   */
  async getStats(): Promise<{
    exists: boolean;
    size: number;
    modified: Date | null;
    checksum: string | null;
  }> {
    if (!existsSync(this.config.beauvoirPath)) {
      return { exists: false, size: 0, modified: null, checksum: null };
    }

    const stats = await stat(this.config.beauvoirPath);
    const content = await readFile(this.config.beauvoirPath, 'utf-8');

    return {
      exists: true,
      size: stats.size,
      modified: stats.mtime,
      checksum: this.computeChecksum(content),
    };
  }

  /**
   * Validate identity document structure
   */
  validate(): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (!this.identity) {
      return { valid: false, issues: ['Identity not loaded'] };
    }

    if (this.identity.corePrinciples.length === 0) {
      issues.push('No core principles found');
    }

    if (this.identity.boundaries.length === 0) {
      issues.push('No boundaries defined');
    }

    if (this.identity.interactionStyle.length === 0) {
      issues.push('No interaction style defined');
    }

    if (!this.identity.recoveryProtocol) {
      issues.push('No recovery protocol defined');
    }

    return { valid: issues.length === 0, issues };
  }
}

/**
 * Create an IdentityLoader with default paths
 */
export function createIdentityLoader(basePath: string): IdentityLoader {
  return new IdentityLoader({
    beauvoirPath: `${basePath}/grimoires/loa/BEAUVOIR.md`,
    notesPath: `${basePath}/grimoires/loa/NOTES.md`,
  });
}

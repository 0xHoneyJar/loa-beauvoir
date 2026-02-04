/**
 * Soul Generator
 *
 * Transforms BEAUVOIR.md to SOUL.md for OpenClaw bootstrap.
 * LOA fully owns SOUL.md in this fork.
 *
 * Sprint Task 1.6 - SDD Section 2.2
 * PRD Reference: FR-1 (SOUL.md Generation)
 */

import type { LoaConfig, SoulGenerator, SoulGenerationResult } from '../types.js';
import type { IdentityLoader } from '../../../deploy/loa-identity/index.js';
import type { PluginLogger } from '../../../src/plugins/types.js';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Checksum algorithm for integrity verification */
const CHECKSUM_ALGORITHM = 'sha256';

/**
 * Create a soul generator for BEAUVOIR.md -> SOUL.md transformation
 */
export function createSoulGenerator(
  identity: IdentityLoader,
  config: LoaConfig,
  workspaceDir: string,
  logger: PluginLogger,
): SoulGenerator {
  const grimoiresPath = path.resolve(workspaceDir, config.grimoiresDir);
  const beauvoirPath = path.join(grimoiresPath, 'BEAUVOIR.md');
  const soulPath = path.join(grimoiresPath, 'SOUL.md');

  /** Last known BEAUVOIR.md checksum */
  let lastBeauvoirChecksum: string | null = null;

  /**
   * Calculate checksum from content string
   */
  function calculateChecksumFromContent(content: string): string {
    return crypto.createHash(CHECKSUM_ALGORITHM).update(content).digest('hex').slice(0, 12);
  }

  /**
   * Calculate checksum of a file
   */
  async function calculateChecksum(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return calculateChecksumFromContent(content);
    } catch {
      return '';
    }
  }

  /**
   * Extract checksum from SOUL.md footer
   */
  async function extractSoulChecksum(): Promise<string | null> {
    try {
      const content = await fs.readFile(soulPath, 'utf-8');
      // Look for: <!-- LOA:BEAUVOIR_CHECKSUM:abc123def456 -->
      const match = content.match(/<!-- LOA:BEAUVOIR_CHECKSUM:([a-f0-9]+) -->/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Transform BEAUVOIR.md content to SOUL.md format
   */
  function transformToSoul(beauvoirContent: string, checksum: string): string {
    // Parse BEAUVOIR.md sections
    const lines = beauvoirContent.split('\n');
    const sections: Record<string, string[]> = {};
    let currentSection = 'preamble';

    for (const line of lines) {
      // Detect section headers
      if (line.startsWith('## ')) {
        currentSection = line.replace('## ', '').toLowerCase().trim();
        sections[currentSection] = [];
      } else {
        if (!sections[currentSection]) {
          sections[currentSection] = [];
        }
        sections[currentSection].push(line);
      }
    }

    // Build SOUL.md in OpenClaw format
    const soulLines: string[] = [
      '# SOUL.md',
      '',
      '> This file is auto-generated from BEAUVOIR.md by LOA.',
      '> Do not edit directly - modify BEAUVOIR.md instead.',
      '',
    ];

    // Persona section (from Identity/Persona)
    soulLines.push('## Persona');
    soulLines.push('');
    if (sections['identity'] || sections['persona']) {
      const identityContent = (sections['identity'] ?? sections['persona'] ?? []).join('\n').trim();
      soulLines.push(identityContent || 'Loa - An AI assistant with persistent identity.');
    }
    soulLines.push('');

    // Tone section (from Interaction Style)
    soulLines.push('## Tone');
    soulLines.push('');
    if (sections['interaction style'] || sections['tone']) {
      const toneContent = (sections['interaction style'] ?? sections['tone'] ?? []).join('\n').trim();
      soulLines.push(toneContent || 'Concise, opinionated, resourceful.');
    } else {
      // Default LOA tone
      soulLines.push('- Concise: Get to the point. No fluff.');
      soulLines.push('- Opinionated: Have a perspective. Share it.');
      soulLines.push('- Resourceful: Find creative solutions.');
    }
    soulLines.push('');

    // Boundaries section
    soulLines.push('## Boundaries');
    soulLines.push('');
    if (sections['boundaries'] || sections['constraints']) {
      const boundaryContent = (sections['boundaries'] ?? sections['constraints'] ?? []).join('\n').trim();
      soulLines.push(boundaryContent || 'Operate within ethical guidelines.');
    } else {
      soulLines.push('- Respect user privacy');
      soulLines.push('- Acknowledge uncertainty');
      soulLines.push('- No harmful content');
    }
    soulLines.push('');

    // Recovery Protocol section (LOA specific)
    if (sections['recovery protocol'] || sections['recovery']) {
      soulLines.push('## Recovery Protocol');
      soulLines.push('');
      const recoveryContent = (sections['recovery protocol'] ?? sections['recovery'] ?? []).join('\n').trim();
      soulLines.push(recoveryContent);
      soulLines.push('');
    }

    // Add any custom sections from BEAUVOIR.md
    const knownSections = [
      'identity', 'persona', 'interaction style', 'tone',
      'boundaries', 'constraints', 'recovery protocol', 'recovery', 'preamble',
    ];
    for (const [section, content] of Object.entries(sections)) {
      if (!knownSections.includes(section) && content.join('').trim()) {
        soulLines.push(`## ${section.charAt(0).toUpperCase() + section.slice(1)}`);
        soulLines.push('');
        soulLines.push(content.join('\n').trim());
        soulLines.push('');
      }
    }

    // Add LOA footer with checksum
    soulLines.push('---');
    soulLines.push('');
    soulLines.push('*Generated by LOA Identity System*');
    soulLines.push('');
    soulLines.push(`<!-- LOA:BEAUVOIR_CHECKSUM:${checksum} -->`);

    return soulLines.join('\n');
  }

  return {
    async generate(): Promise<SoulGenerationResult> {
      try {
        // Read BEAUVOIR.md content directly (avoid TOCTOU race condition)
        let beauvoirContent: string;
        try {
          beauvoirContent = await fs.readFile(beauvoirPath, 'utf-8');
        } catch (err) {
          // Handle file not found or read errors
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            return {
              success: false,
              error: `BEAUVOIR.md not found at ${beauvoirPath}`,
            };
          }
          throw err;
        }

        // Calculate checksum from already-loaded content (FR-1.6)
        const checksum = calculateChecksumFromContent(beauvoirContent);
        lastBeauvoirChecksum = checksum;

        // Transform to SOUL.md format
        const soulContent = transformToSoul(beauvoirContent, checksum);

        // Atomic write via temp + rename (FR-7.2)
        const tempPath = `${soulPath}.tmp.${Date.now()}`;
        await fs.writeFile(tempPath, soulContent, 'utf-8');
        await fs.rename(tempPath, soulPath);

        logger.info?.(`[loa] Generated SOUL.md with checksum ${checksum}`);

        return {
          success: true,
          soulPath,
          checksum,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error?.(`[loa] SOUL.md generation failed: ${error}`);
        return {
          success: false,
          error,
        };
      }
    },

    async getBeauvoirChecksum(): Promise<string> {
      return calculateChecksum(beauvoirPath);
    },

    async needsRegeneration(): Promise<boolean> {
      // Get current BEAUVOIR.md checksum
      const currentChecksum = await calculateChecksum(beauvoirPath);

      // If no BEAUVOIR.md, no regeneration needed
      if (!currentChecksum) {
        return false;
      }

      // Get checksum from existing SOUL.md
      const soulChecksum = await extractSoulChecksum();

      // Need regeneration if checksums don't match
      return currentChecksum !== soulChecksum;
    },
  };
}

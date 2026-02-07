// .claude/lib/workflow/templates/base.ts — Template registry + base class (SDD 3.2)

import { createHash } from "node:crypto";

/** Constraint applied to a specific tool within an action policy. */
export interface ConstraintDef {
  draftOnly?: boolean;
  labelsOnly?: string[];
  maxCommentLength?: number;
  deniedEvents?: string[];
}

/** Action policy for template-specific tool access. */
export interface ActionPolicyDef {
  templateId: string;
  allow: string[];
  deny: string[];
  constraints?: Record<string, ConstraintDef>;
}

/** Item resolved by a template for processing. */
export interface TemplateItem {
  key: string;
  hash: string;
  data: Record<string, unknown>;
}

/** Abstract base class for all job templates. */
export abstract class BaseTemplate {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly actionPolicy: ActionPolicyDef;
  abstract readonly canonicalHashFields: string[];
  abstract readonly excludedHashFields: string[];

  abstract resolveItems(): Promise<TemplateItem[]>;
  abstract buildPrompt(item: TemplateItem): string;

  /** Compute SHA-256 hash from canonical fields of item data. */
  computeStateHash(item: TemplateItem): string {
    const canonical: Record<string, unknown> = {};
    const keys = Object.keys(item.data)
      .filter((k) => this.canonicalHashFields.includes(k))
      .filter((k) => !this.excludedHashFields.includes(k))
      .sort();
    for (const k of keys) {
      canonical[k] = item.data[k];
    }
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  }
}

/** Registry for template discovery and lookup. */
export class TemplateRegistry {
  private templates = new Map<string, BaseTemplate>();

  register(template: BaseTemplate): void {
    this.templates.set(template.id, template);
  }

  get(id: string): BaseTemplate | undefined {
    return this.templates.get(id);
  }

  list(): BaseTemplate[] {
    return Array.from(this.templates.values());
  }
}

/** Global template registry instance. Templates self-register at import time. */
export const templateRegistry = new TemplateRegistry();

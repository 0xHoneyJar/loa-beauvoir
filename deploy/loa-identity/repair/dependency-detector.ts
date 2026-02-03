/**
 * Dependency Detector - Check and classify dependencies
 *
 * Detects missing or outdated dependencies and classifies them
 * against the signed allowlist.
 *
 * @module deploy/loa-identity/repair/dependency-detector
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  AllowlistSigner,
  SignedPackageAllowlist,
} from '../security/allowlist-signer.js';

const exec = promisify(execCb);

export interface DependencyIssue {
  type: 'npm' | 'apt' | 'python';
  package: string;
  currentVersion: string | null;
  requiredVersion: string | null;
  status: 'missing' | 'outdated' | 'incompatible';
  inAllowlist: boolean;
  canAutoRepair: boolean;
}

export interface DependencyReport {
  issues: DependencyIssue[];
  summary: {
    total: number;
    missing: number;
    outdated: number;
    autoRepairable: number;
    requiresApproval: number;
  };
}

/**
 * DependencyDetector checks system dependencies and classifies issues.
 */
export class DependencyDetector {
  private allowlist: SignedPackageAllowlist | null = null;
  private allowlistSigner: AllowlistSigner;

  constructor(allowlistSigner?: AllowlistSigner) {
    this.allowlistSigner = allowlistSigner ?? new AllowlistSigner();
  }

  /**
   * Load allowlist for classification
   */
  async loadAllowlist(allowlistPath: string): Promise<void> {
    try {
      this.allowlist = await this.allowlistSigner.loadAllowlist(allowlistPath);
    } catch (e) {
      console.warn('[dependency-detector] No valid allowlist, classification disabled');
    }
  }

  /**
   * Run full dependency scan
   */
  async scan(options?: {
    checkNpm?: boolean;
    checkApt?: boolean;
    checkPython?: boolean;
  }): Promise<DependencyReport> {
    const issues: DependencyIssue[] = [];

    const checkNpm = options?.checkNpm ?? true;
    const checkApt = options?.checkApt ?? true;
    const checkPython = options?.checkPython ?? true;

    if (checkNpm) {
      const npmIssues = await this.checkNpmDependencies();
      issues.push(...npmIssues);
    }

    if (checkApt) {
      const aptIssues = await this.checkAptDependencies();
      issues.push(...aptIssues);
    }

    if (checkPython) {
      const pythonIssues = await this.checkPythonDependencies();
      issues.push(...pythonIssues);
    }

    // Calculate summary
    const summary = {
      total: issues.length,
      missing: issues.filter((i) => i.status === 'missing').length,
      outdated: issues.filter((i) => i.status === 'outdated').length,
      autoRepairable: issues.filter((i) => i.canAutoRepair).length,
      requiresApproval: issues.filter((i) => !i.canAutoRepair && i.inAllowlist).length,
    };

    return { issues, summary };
  }

  /**
   * Check NPM dependencies
   */
  private async checkNpmDependencies(): Promise<DependencyIssue[]> {
    const issues: DependencyIssue[] = [];

    // Check if package.json exists
    if (!existsSync('package.json')) {
      return issues;
    }

    try {
      // Run npm outdated
      const { stdout } = await exec('npm outdated --json', {
        timeout: 60000,
      }).catch(() => ({ stdout: '{}' }));

      const outdated = JSON.parse(stdout || '{}') as Record<
        string,
        { current: string; wanted: string; latest: string }
      >;

      for (const [pkg, info] of Object.entries(outdated)) {
        const inAllowlist = this.isPackageAllowed('npm', pkg);
        const canAutoRepair = inAllowlist && info.current !== info.wanted;

        issues.push({
          type: 'npm',
          package: pkg,
          currentVersion: info.current,
          requiredVersion: info.wanted,
          status: info.current ? 'outdated' : 'missing',
          inAllowlist,
          canAutoRepair,
        });
      }

      // Check for missing peer dependencies
      const { stdout: auditOut } = await exec('npm ls --json 2>/dev/null', {
        timeout: 60000,
      }).catch(() => ({ stdout: '{}' }));

      const tree = JSON.parse(auditOut || '{}');
      if (tree.problems) {
        for (const problem of tree.problems) {
          // Parse "missing peer" or "missing:" patterns
          const missingMatch = problem.match(/missing: (\S+)@/);
          if (missingMatch) {
            const pkg = missingMatch[1];
            if (!issues.some((i) => i.package === pkg)) {
              const inAllowlist = this.isPackageAllowed('npm', pkg);
              issues.push({
                type: 'npm',
                package: pkg,
                currentVersion: null,
                requiredVersion: null,
                status: 'missing',
                inAllowlist,
                canAutoRepair: inAllowlist,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('[dependency-detector] NPM check error:', e);
    }

    return issues;
  }

  /**
   * Check APT dependencies
   */
  private async checkAptDependencies(): Promise<DependencyIssue[]> {
    const issues: DependencyIssue[] = [];

    // Required system packages
    const requiredPackages = ['git', 'python3', 'python3-pip'];

    for (const pkg of requiredPackages) {
      try {
        await exec(`dpkg -s ${pkg}`, { timeout: 5000 });
      } catch {
        // Package not installed
        const inAllowlist = this.isPackageAllowed('apt', pkg);
        issues.push({
          type: 'apt',
          package: pkg,
          currentVersion: null,
          requiredVersion: null,
          status: 'missing',
          inAllowlist,
          canAutoRepair: inAllowlist,
        });
      }
    }

    // Check for upgradable packages
    try {
      const { stdout } = await exec('apt list --upgradable 2>/dev/null', {
        timeout: 30000,
      });

      const lines = stdout.split('\n').filter((l) => l.includes('/'));
      for (const line of lines) {
        const match = line.match(/^(\S+)\/\S+ (\S+)/);
        if (match) {
          const [, pkg, version] = match;
          const pkgName = pkg.split('/')[0];
          const inAllowlist = this.isPackageAllowed('apt', pkgName);

          if (requiredPackages.includes(pkgName)) {
            issues.push({
              type: 'apt',
              package: pkgName,
              currentVersion: 'installed',
              requiredVersion: version,
              status: 'outdated',
              inAllowlist,
              canAutoRepair: inAllowlist,
            });
          }
        }
      }
    } catch {
      // apt list may not be available
    }

    return issues;
  }

  /**
   * Check Python dependencies (for embedding service)
   */
  private async checkPythonDependencies(): Promise<DependencyIssue[]> {
    const issues: DependencyIssue[] = [];

    // Check if requirements.txt exists for embedding service
    const requirementsPath = 'deploy/loa-identity/embedding-service/requirements.txt';

    if (!existsSync(requirementsPath)) {
      return issues;
    }

    try {
      // Check if Python is available
      await exec('python3 --version', { timeout: 5000 });

      // Get installed packages
      const { stdout: installedRaw } = await exec('pip3 list --format=json', {
        timeout: 30000,
      }).catch(() => ({ stdout: '[]' }));

      const installed = JSON.parse(installedRaw) as Array<{
        name: string;
        version: string;
      }>;
      const installedMap = new Map(installed.map((p) => [p.name.toLowerCase(), p.version]));

      // Read requirements
      const requirements = await readFile(requirementsPath, 'utf-8');
      const requiredPackages = requirements
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => {
          const match = l.match(/^([a-zA-Z0-9_-]+)/);
          return match ? match[1].toLowerCase() : null;
        })
        .filter(Boolean) as string[];

      for (const pkg of requiredPackages) {
        const currentVersion = installedMap.get(pkg);

        if (!currentVersion) {
          issues.push({
            type: 'python',
            package: pkg,
            currentVersion: null,
            requiredVersion: null,
            status: 'missing',
            inAllowlist: true, // Python deps are in requirements.txt, treated as allowed
            canAutoRepair: true,
          });
        }
      }
    } catch {
      // Python not available
      issues.push({
        type: 'apt',
        package: 'python3',
        currentVersion: null,
        requiredVersion: null,
        status: 'missing',
        inAllowlist: this.isPackageAllowed('apt', 'python3'),
        canAutoRepair: this.isPackageAllowed('apt', 'python3'),
      });
    }

    return issues;
  }

  /**
   * Check if package is in allowlist
   */
  private isPackageAllowed(type: 'npm' | 'apt', name: string): boolean {
    if (!this.allowlist) return false;

    const spec = this.allowlistSigner.isPackageAllowed(this.allowlist, type, name);
    return spec !== null;
  }

  /**
   * Get repair recommendations
   */
  getRepairRecommendations(report: DependencyReport): Array<{
    action: string;
    packages: string[];
    requiresApproval: boolean;
  }> {
    const recommendations: Array<{
      action: string;
      packages: string[];
      requiresApproval: boolean;
    }> = [];

    // Group by type and status
    const npmMissing = report.issues.filter(
      (i) => i.type === 'npm' && i.status === 'missing' && i.canAutoRepair
    );
    const npmOutdated = report.issues.filter(
      (i) => i.type === 'npm' && i.status === 'outdated' && i.canAutoRepair
    );
    const aptMissing = report.issues.filter(
      (i) => i.type === 'apt' && i.status === 'missing' && i.canAutoRepair
    );
    const pythonMissing = report.issues.filter(
      (i) => i.type === 'python' && i.status === 'missing' && i.canAutoRepair
    );

    if (npmMissing.length > 0) {
      recommendations.push({
        action: 'npm install ' + npmMissing.map((i) => i.package).join(' '),
        packages: npmMissing.map((i) => i.package),
        requiresApproval: false,
      });
    }

    if (npmOutdated.length > 0) {
      recommendations.push({
        action: 'npm update ' + npmOutdated.map((i) => i.package).join(' '),
        packages: npmOutdated.map((i) => i.package),
        requiresApproval: false,
      });
    }

    if (aptMissing.length > 0) {
      recommendations.push({
        action: 'apt-get install -y ' + aptMissing.map((i) => i.package).join(' '),
        packages: aptMissing.map((i) => i.package),
        requiresApproval: true, // APT requires root
      });
    }

    if (pythonMissing.length > 0) {
      recommendations.push({
        action: 'pip3 install -r requirements.txt',
        packages: pythonMissing.map((i) => i.package),
        requiresApproval: false,
      });
    }

    // Add non-allowlisted issues requiring approval
    const notAllowed = report.issues.filter((i) => !i.inAllowlist);
    if (notAllowed.length > 0) {
      recommendations.push({
        action: 'Manual review required',
        packages: notAllowed.map((i) => i.package),
        requiresApproval: true,
      });
    }

    return recommendations;
  }
}

/**
 * Create DependencyDetector with allowlist
 */
export async function createDependencyDetector(
  allowlistPath?: string
): Promise<DependencyDetector> {
  const detector = new DependencyDetector();

  if (allowlistPath && existsSync(allowlistPath)) {
    await detector.loadAllowlist(allowlistPath);
  }

  return detector;
}

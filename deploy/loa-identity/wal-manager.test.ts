/**
 * Loa Cloud Stack - WAL Manager Tests
 *
 * Tests for the Write-Ahead Log persistence layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import WALManager from './wal-manager';

describe('WALManager', () => {
  let walManager: WALManager;
  let tempDir: string;
  let walDir: string;
  let grimoiresDir: string;

  beforeEach(async () => {
    // Create temp directories
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'loa-wal-test-'));
    walDir = path.join(tempDir, 'wal');
    grimoiresDir = path.join(tempDir, 'grimoires');

    await fs.promises.mkdir(walDir, { recursive: true });
    await fs.promises.mkdir(grimoiresDir, { recursive: true });

    // Set environment
    process.env.WAL_DIR = walDir;
    process.env.GRIMOIRES_DIR = grimoiresDir;
    process.env.BEADS_DIR = path.join(tempDir, '.beads');

    walManager = new WALManager(walDir);
    await walManager.initialize();
  });

  afterEach(async () => {
    await walManager.shutdown();
    // Clean up temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('write operations', () => {
    it('should write a file and create WAL entry', async () => {
      const content = 'Hello, Loa!';
      await walManager.write('loa/test.md', content);

      // Verify file was written
      const filePath = path.join(grimoiresDir, 'loa/test.md');
      const fileContent = await fs.promises.readFile(filePath, 'utf8');
      expect(fileContent).toBe(content);

      // Verify WAL entry was created
      const entries = await walManager.readAllEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].op).toBe('write');
      expect(entries[0].path).toBe('loa/test.md');
      expect(entries[0].checksum).toMatch(/^sha256:/);
    });

    it('should handle binary content', async () => {
      const content = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await walManager.write('loa/binary.bin', content);

      const filePath = path.join(grimoiresDir, 'loa/binary.bin');
      const fileContent = await fs.promises.readFile(filePath);
      expect(fileContent).toEqual(content);
    });

    it('should create parent directories', async () => {
      await walManager.write('loa/deep/nested/file.md', 'content');

      const filePath = path.join(grimoiresDir, 'loa/deep/nested/file.md');
      const exists = fs.existsSync(filePath);
      expect(exists).toBe(true);
    });
  });

  describe('delete operations', () => {
    it('should delete a file and create WAL entry', async () => {
      // Create a file first
      const filePath = path.join(grimoiresDir, 'loa/to-delete.md');
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, 'delete me');

      await walManager.delete('loa/to-delete.md');

      // Verify file was deleted
      const exists = fs.existsSync(filePath);
      expect(exists).toBe(false);

      // Verify WAL entry
      const entries = await walManager.readAllEntries();
      expect(entries.some((e) => e.op === 'delete' && e.path === 'loa/to-delete.md')).toBe(true);
    });

    it('should handle deleting non-existent file', async () => {
      // Should not throw
      await expect(walManager.delete('loa/does-not-exist.md')).resolves.not.toThrow();
    });
  });

  describe('mkdir operations', () => {
    it('should create directory and WAL entry', async () => {
      await walManager.mkdir('loa/new-dir');

      const dirPath = path.join(grimoiresDir, 'loa/new-dir');
      const stat = await fs.promises.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);

      const entries = await walManager.readAllEntries();
      expect(entries.some((e) => e.op === 'mkdir' && e.path === 'loa/new-dir')).toBe(true);
    });
  });

  describe('WAL replay', () => {
    it('should replay write entries', async () => {
      // Write some files
      await walManager.write('loa/file1.md', 'content 1');
      await walManager.write('loa/file2.md', 'content 2');

      // Delete the actual files (simulate crash)
      await fs.promises.rm(grimoiresDir, { recursive: true, force: true });
      await fs.promises.mkdir(grimoiresDir, { recursive: true });

      // Replay
      const replayed = await walManager.replay();
      expect(replayed).toBe(2);

      // Verify files were restored
      const file1 = await fs.promises.readFile(path.join(grimoiresDir, 'loa/file1.md'), 'utf8');
      const file2 = await fs.promises.readFile(path.join(grimoiresDir, 'loa/file2.md'), 'utf8');
      expect(file1).toBe('content 1');
      expect(file2).toBe('content 2');
    });

    it('should replay in sequence order', async () => {
      await walManager.write('loa/seq.md', 'version 1');
      await walManager.write('loa/seq.md', 'version 2');
      await walManager.write('loa/seq.md', 'version 3');

      // Delete and replay
      await fs.promises.rm(grimoiresDir, { recursive: true, force: true });
      await fs.promises.mkdir(grimoiresDir, { recursive: true });
      await walManager.replay();

      // Should have the latest version
      const content = await fs.promises.readFile(path.join(grimoiresDir, 'loa/seq.md'), 'utf8');
      expect(content).toBe('version 3');
    });

    it('should replay delete entries', async () => {
      await walManager.write('loa/delete-test.md', 'content');
      await walManager.delete('loa/delete-test.md');

      // Restore the file manually (simulate partial state)
      await fs.promises.mkdir(path.join(grimoiresDir, 'loa'), { recursive: true });
      await fs.promises.writeFile(path.join(grimoiresDir, 'loa/delete-test.md'), 'restored');

      // Replay should delete it
      await walManager.replay();

      const exists = fs.existsSync(path.join(grimoiresDir, 'loa/delete-test.md'));
      expect(exists).toBe(false);
    });

    it('should detect checksum mismatches', async () => {
      await walManager.write('loa/checksum.md', 'original');

      // Manually corrupt the WAL entry
      const walFile = path.join(walDir, 'current.wal');
      let walContent = await fs.promises.readFile(walFile, 'utf8');
      walContent = walContent.replace(/"data":"[^"]+"/g, '"data":"Y29ycnVwdGVk"'); // "corrupted" in base64
      await fs.promises.writeFile(walFile, walContent);

      // Delete file and replay
      await fs.promises.rm(grimoiresDir, { recursive: true, force: true });
      await fs.promises.mkdir(grimoiresDir, { recursive: true });

      // Should skip the corrupted entry (checksum mismatch)
      const replayed = await walManager.replay();
      expect(replayed).toBe(0);
    });
  });

  describe('sync status', () => {
    it('should track pending entries', async () => {
      await walManager.write('loa/pending.md', 'content');

      const status = await walManager.getStatus();
      expect(status.wal.entries_pending_r2).toBe(1);
      expect(status.wal.entries_pending_git).toBe(1);
      expect(status.wal.last_write).not.toBeNull();
    });
  });

  describe('entry ordering', () => {
    it('should increment sequence numbers', async () => {
      await walManager.write('loa/a.md', 'a');
      await walManager.write('loa/b.md', 'b');
      await walManager.write('loa/c.md', 'c');

      const entries = await walManager.readAllEntries();
      expect(entries[0].seq).toBeLessThan(entries[1].seq);
      expect(entries[1].seq).toBeLessThan(entries[2].seq);
    });

    it('should preserve entry timestamps', async () => {
      const before = Date.now();
      await walManager.write('loa/time.md', 'content');
      const after = Date.now();

      const entries = await walManager.readAllEntries();
      expect(entries[0].ts).toBeGreaterThanOrEqual(before);
      expect(entries[0].ts).toBeLessThanOrEqual(after);
    });
  });
});

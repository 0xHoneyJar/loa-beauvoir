/**
 * WAL Module - Segmented Write-Ahead Log with crash recovery
 *
 * @module deploy/loa-identity/wal
 */

export {
  SegmentedWALManager,
  createSegmentedWALManager,
  type WALEntry,
  type WALSegment,
  type WALCheckpoint,
  type SegmentedWALConfig,
} from './wal-manager.js';

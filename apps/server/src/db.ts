// Storage for the queue.
//
// Metadata lives in SQLite, ciphertext lives on disk. Two reasons for the split:
// a 12 MB row makes SQLite work hard for no benefit, and delete-on-ack becomes
// an unlink rather than a vacuum.
//
// node:sqlite is used deliberately, so a self-hoster needs no native build
// toolchain on their VPS. See docs/VPS_SETUP.md.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '@inkpipe/protocol';

export interface Device {
  id: string;
  accountId: string;
  role: 'phone' | 'pc';
  ed25519PublicKey: string;
  x25519PublicKey: string | null;
  label: string;
}

/** What a device list shows. Deliberately carries no key material: a public
 *  key is not a secret, but printing one invites it into a screenshot and it
 *  identifies the device across every account it has ever been on. */
export interface DeviceSummary {
  id: string;
  role: 'phone' | 'pc';
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  pendingBlobs: number;
}

export interface BlobRow {
  blobId: string;
  accountId: string;
  fromDeviceId: string;
  sessionId: string;
  seq: number;
  sizeBytes: number;
  capturedAt: string;
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly blobDir: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.blobDir = join(dataDir, 'blobs');
    mkdirSync(this.blobDir, { recursive: true });

    this.db = new DatabaseSync(join(dataDir, 'inkpipe.db'));
    // WAL so a slow download does not block an upload.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id          TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id                  TEXT PRIMARY KEY,
        account_id          TEXT NOT NULL REFERENCES accounts(id),
        role                TEXT NOT NULL CHECK (role IN ('phone','pc')),
        ed25519_public_key  TEXT NOT NULL UNIQUE,
        x25519_public_key   TEXT,
        label               TEXT NOT NULL,
        created_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pairings (
        token       TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL REFERENCES accounts(id),
        expires_at  TEXT NOT NULL,
        used_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS blobs (
        blob_id         TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES accounts(id),
        from_device_id  TEXT NOT NULL REFERENCES devices(id),
        session_id      TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        size_bytes      INTEGER NOT NULL,
        captured_at     TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS blobs_by_account ON blobs(account_id, created_at);
      CREATE INDEX IF NOT EXISTS blobs_by_device  ON blobs(from_device_id);
    `);

    // Added after the schema shipped, so it goes on separately. A device list
    // without "when did this last do anything" tells you almost nothing about
    // which entry is the phone in your pocket and which is the one you paired
    // once from a browser and forgot.
    const columns = this.db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'last_seen_at')) {
      this.db.exec('ALTER TABLE devices ADD COLUMN last_seen_at TEXT');
    }
  }

  // -------------------------------------------------------------------------
  // Accounts and devices
  // -------------------------------------------------------------------------

  createAccount(id: string, now: string): void {
    this.db.prepare('INSERT INTO accounts (id, created_at) VALUES (?, ?)').run(id, now);
  }

  insertDevice(d: Device, now: string): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, account_id, role, ed25519_public_key, x25519_public_key, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.accountId, d.role, d.ed25519PublicKey, d.x25519PublicKey, d.label, now);
  }

  getDevice(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as
      | Record<string, string>
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      role: row.role as 'phone' | 'pc',
      ed25519PublicKey: row.ed25519_public_key,
      x25519PublicKey: row.x25519_public_key ?? null,
      label: row.label,
    };
  }

  /**
   * Look a device up by its identity public key.
   *
   * This is what makes recovery work: a desktop restored from its recovery
   * phrase derives the same keys, so it can find the device row it already owns
   * instead of creating a second account that cannot see its own pending pages.
   */
  getDeviceByIdentityKey(ed25519PublicKey: string): Device | null {
    const row = this.db
      .prepare('SELECT * FROM devices WHERE ed25519_public_key = ?')
      .get(ed25519PublicKey) as Record<string, string> | undefined;
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      role: row.role as 'phone' | 'pc',
      ed25519PublicKey: row.ed25519_public_key,
      x25519PublicKey: row.x25519_public_key ?? null,
      label: row.label,
    };
  }

  /** The desktop's content key, which is what a phone seals to. */
  getPcContentKey(accountId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT x25519_public_key FROM devices
         WHERE account_id = ? AND role = 'pc' AND x25519_public_key IS NOT NULL
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(accountId) as { x25519_public_key: string } | undefined;
    return row?.x25519_public_key ?? null;
  }

  countDevices(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
  }

  /**
   * Every device on an account, with enough to decide whether to revoke one.
   *
   * The owner asked for this after losing track of what was paired, which is
   * easy once pairing has happened twice and once from a browser. A device you
   * cannot see is a device you cannot revoke.
   */
  listDevices(accountId: string): DeviceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.role, d.label, d.created_at, d.last_seen_at,
                (SELECT COUNT(*) FROM blobs b
                  WHERE b.from_device_id = d.id) AS pending
           FROM devices d
          WHERE d.account_id = ?
          ORDER BY d.created_at ASC`,
      )
      .all(accountId) as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      id: String(row.id),
      role: row.role as 'phone' | 'pc',
      label: String(row.label),
      createdAt: String(row.created_at),
      lastSeenAt: row.last_seen_at === null || row.last_seen_at === undefined
        ? null
        : String(row.last_seen_at),
      pendingBlobs: Number(row.pending ?? 0),
    }));
  }

  /** Record that a device just made an authenticated request. */
  touchDevice(id: string, now: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  /** How many desktops the account has. Revoking the last one strands it. */
  countPcs(accountId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND role = 'pc'")
      .get(accountId) as { n: number };
    return row.n;
  }

  /**
   * Remove a device and everything it uploaded that nobody has collected.
   *
   * The blobs go because the schema points at the device, and because they are
   * useless once it is gone: nothing will ever ack them, so they would sit
   * against the account quota until the retention sweep.
   *
   * Returns how many pages were discarded, so the caller can say so rather than
   * destroying work quietly.
   */
  deleteDevice(id: string): { deletedBlobs: number } {
    const blobIds = this.db
      .prepare('SELECT blob_id FROM blobs WHERE from_device_id = ?')
      .all(id) as Array<{ blob_id: string }>;

    // Ciphertext lives on disk, so removing the row is only half of it.
    for (const { blob_id: blobId } of blobIds) {
      const path = join(this.blobDir, blobId);
      if (existsSync(path)) unlinkSync(path);
    }

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM blobs WHERE from_device_id = ?').run(id);
      this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { deletedBlobs: blobIds.length };
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  insertPairing(token: string, accountId: string, expiresAt: string): void {
    this.db
      .prepare('INSERT INTO pairings (token, account_id, expires_at) VALUES (?, ?, ?)')
      .run(token, accountId, expiresAt);
  }

  /** Single use: returns the account only if the token is unused and unexpired,
   *  and marks it used in the same step so a race cannot redeem it twice. */
  redeemPairing(token: string, now: string): string | null {
    const row = this.db
      .prepare('SELECT account_id, expires_at, used_at FROM pairings WHERE token = ?')
      .get(token) as { account_id: string; expires_at: string; used_at: string | null } | undefined;

    if (!row) return null;
    if (row.used_at !== null) return null;
    if (row.expires_at <= now) return null;

    const result = this.db
      .prepare('UPDATE pairings SET used_at = ? WHERE token = ? AND used_at IS NULL')
      .run(now, token);
    if (result.changes === 0) return null;

    return row.account_id;
  }

  // -------------------------------------------------------------------------
  // Blobs
  // -------------------------------------------------------------------------

  hasBlob(blobId: string): boolean {
    return this.db.prepare('SELECT 1 FROM blobs WHERE blob_id = ?').get(blobId) !== undefined;
  }

  bytesUsedByDevice(deviceId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM blobs WHERE from_device_id = ?')
      .get(deviceId) as { n: number };
    return row.n;
  }

  insertBlob(row: BlobRow, ciphertext: Uint8Array): void {
    // File first: a row with no file is a broken download, a file with no row is
    // merely garbage that pruning will remove.
    writeFileSync(this.blobPath(row.blobId), ciphertext);
    this.db
      .prepare(
        `INSERT INTO blobs (blob_id, account_id, from_device_id, session_id, seq, size_bytes, captured_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.blobId, row.accountId, row.fromDeviceId, row.sessionId,
        row.seq, row.sizeBytes, row.capturedAt, row.createdAt,
      );
  }

  pendingBlobs(accountId: string): BlobRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM blobs WHERE account_id = ?
         ORDER BY session_id, seq`,
      )
      .all(accountId) as Record<string, never>[];
    return rows.map(toBlobRow);
  }

  getBlob(blobId: string, accountId: string): { row: BlobRow; ciphertext: Uint8Array } | null {
    const row = this.db
      .prepare('SELECT * FROM blobs WHERE blob_id = ? AND account_id = ?')
      .get(blobId, accountId) as Record<string, never> | undefined;
    if (!row) return null;

    const path = this.blobPath(blobId);
    if (!existsSync(path)) return null;
    return { row: toBlobRow(row), ciphertext: new Uint8Array(readFileSync(path)) };
  }

  /** Delete on ack. Scoped by account so one account can never delete another's. */
  deleteBlobs(blobIds: string[], accountId: string): number {
    let deleted = 0;
    for (const id of blobIds) {
      const result = this.db
        .prepare('DELETE FROM blobs WHERE blob_id = ? AND account_id = ?')
        .run(id, accountId);
      if (result.changes > 0) {
        deleted++;
        try {
          unlinkSync(this.blobPath(id));
        } catch {
          // Already gone. The row is what makes it visible, so this is fine.
        }
      }
    }
    return deleted;
  }

  /** Retention sweep, decision 14. */
  pruneExpired(now: Date): number {
    const cutoff = new Date(now.getTime() - LIMITS.retentionDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare('SELECT blob_id FROM blobs WHERE created_at < ?')
      .all(cutoff) as { blob_id: string }[];
    for (const { blob_id } of rows) {
      this.db.prepare('DELETE FROM blobs WHERE blob_id = ?').run(blob_id);
      try {
        unlinkSync(this.blobPath(blob_id));
      } catch { /* already gone */ }
    }
    return rows.length;
  }

  countPendingBlobs(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }

  private blobPath(blobId: string): string {
    // blobId is a validated UUID by the time it reaches here, so it cannot
    // contain a path separator. Asserting anyway: this is the one place where a
    // bad id would become a filesystem write outside the blob directory.
    if (!/^[0-9a-fA-F-]{36}$/.test(blobId)) {
      throw new Error(`refusing to build a blob path from ${JSON.stringify(blobId)}`);
    }
    return join(this.blobDir, `${blobId}.bin`);
  }
}

function toBlobRow(row: Record<string, never>): BlobRow {
  return {
    blobId: row.blob_id,
    accountId: row.account_id,
    fromDeviceId: row.from_device_id,
    sessionId: row.session_id,
    seq: row.seq,
    sizeBytes: row.size_bytes,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
  };
}

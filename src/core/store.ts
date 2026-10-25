import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type {
  BaselineRecord,
  CaseRecord,
  Change,
  ChangeStats,
  Finding,
  PruneResult,
  ReferenceInfo,
  RollbackRecord,
  RunRecord,
  Snapshot,
  SnapshotMeta,
  SnapshotRow,
  SnapshotWarning,
  StoreStats,
} from "./types.js";
import { baselineId, sha256, stableStringify } from "./util.js";

type DbRow = Record<string, unknown>;

export type BlobResult = {
  hash: string;
  size: number;
};

export type SaveSnapshotOptions = {
  durationMs?: number;
  pinned?: boolean;
};

export class Store {
  readonly home: string;
  readonly dbPath: string;
  readonly objectsDir: string;
  private readonly db: DatabaseSync;

  constructor(home: string) {
    this.home = path.resolve(home);
    this.dbPath = path.join(this.home, "db.sqlite");
    this.objectsDir = path.join(this.home, "objects");
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(path.join(this.home, "logs"), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        label TEXT,
        trigger TEXT NOT NULL,
        profile TEXT NOT NULL,
        host_json TEXT NOT NULL DEFAULT '{}',
        data_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        warnings_json TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        command_signature TEXT NOT NULL,
        cwd TEXT NOT NULL,
        project_id TEXT,
        pre_snapshot TEXT NOT NULL,
        post_snapshot TEXT,
        exit_code INTEGER,
        signal TEXT,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        stderr_tail TEXT,
        stdout_tail TEXT,
        reference_snapshot TEXT,
        change_signatures_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        run_id TEXT NOT NULL,
        reference_snapshot TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        summary TEXT,
        rollback_id TEXT
      );

      CREATE TABLE IF NOT EXISTS baselines (
        id TEXT PRIMARY KEY,
        label TEXT,
        snapshot_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS rollbacks (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        case_id TEXT,
        run_id TEXT,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        safety_snapshot TEXT,
        log_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_stats (
        signature TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        path TEXT NOT NULL,
        runs_present INTEGER NOT NULL DEFAULT 0,
        fails_present INTEGER NOT NULL DEFAULT 0,
        runs_absent INTEGER NOT NULL DEFAULT 0,
        fails_absent INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_lookup ON runs(project_id, command_signature, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_baselines_active ON baselines(active);
      CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);

      INSERT INTO meta(key, value) VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING;
    `);
    this.ensureColumn("snapshots", "host_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("snapshots", "pinned", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("PRAGMA user_version = 1;");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
    if (!rows.some((row) => String(row.name) === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Ignore rollback failure.
      }
      throw error;
    }
  }

  putBlob(data: string | Buffer): BlobResult {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const hash = sha256(buffer);
    const dir = path.join(this.objectsDir, hash.slice(0, 2));
    const file = path.join(dir, `${hash}.gz`);
    if (existsSync(file)) {
      return { hash, size: statSync(file).size };
    }
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, gzipSync(buffer, { level: 9 }));
    renameSync(temp, file);
    return { hash, size: statSync(file).size };
  }

  getBlob(hash: string): Buffer {
    const file = this.blobPath(hash);
    if (!existsSync(file)) {
      throw new Error(`Missing blob ${hash}. The store may be incomplete.`);
    }
    return gunzipSync(readFileSync(file));
  }

  blobExists(hash: string): boolean {
    return existsSync(this.blobPath(hash));
  }

  blobPath(hash: string): string {
    return path.join(this.objectsDir, hash.slice(0, 2), `${hash}.gz`);
  }

  putJsonBlob(value: unknown): BlobResult {
    return this.putBlob(stableStringify(value));
  }

  getJsonBlob<T>(hash: string): T {
    return JSON.parse(this.getBlob(hash).toString("utf8")) as T;
  }

  saveSnapshot(snapshot: Snapshot, options: SaveSnapshotOptions = {}): SnapshotMeta {
    const blob = this.putJsonBlob(snapshot);
    const createdAt = Date.parse(snapshot.createdAt) || Date.now();
    const host = {
      hostname: snapshot.host.hostname,
      os: snapshot.host.os,
      version: snapshot.host.version,
      build: snapshot.host.build,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshots
          (id, created_at, label, trigger, profile, host_json, data_hash, size_bytes, duration_ms, warnings_json, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        createdAt,
        snapshot.label ?? null,
        snapshot.trigger,
        snapshot.profile,
        JSON.stringify(host),
        blob.hash,
        blob.size,
        Math.max(0, Math.round(options.durationMs ?? 0)),
        JSON.stringify(snapshot.warnings ?? []),
        options.pinned ? 1 : 0,
      );
    return {
      id: snapshot.id,
      createdAt,
      label: snapshot.label ?? null,
      trigger: snapshot.trigger,
      profile: snapshot.profile,
      dataHash: blob.hash,
      sizeBytes: blob.size,
      durationMs: Math.max(0, Math.round(options.durationMs ?? 0)),
      warnings: snapshot.warnings ?? [],
      pinned: Boolean(options.pinned),
      host,
    };
  }

  listSnapshots(limit = 50, offset = 0): SnapshotMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM snapshots ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as DbRow[];
    return rows.map((row) => this.rowToSnapshotMeta(row));
  }

  getSnapshotRow(ref: string): SnapshotRow | null {
    const row = this.findSnapshotRow(ref);
    return row ? (row as SnapshotRow) : null;
  }

  getSnapshot(ref: string): Snapshot {
    const row = this.findSnapshotRow(ref);
    if (!row) throw new Error(`Snapshot not found: ${ref}`);
    return this.getJsonBlob<Snapshot>(String(row.data_hash));
  }

  findSnapshot(ref: string): Snapshot | null {
    const row = this.findSnapshotRow(ref);
    return row ? this.getJsonBlob<Snapshot>(String(row.data_hash)) : null;
  }

  latestSnapshot(): Snapshot | null {
    const row = this.db.prepare("SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1").get() as
      | DbRow
      | undefined;
    return row ? this.getJsonBlob<Snapshot>(String(row.data_hash)) : null;
  }

  latestSnapshotMeta(): SnapshotMeta | null {
    const row = this.db.prepare("SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1").get() as
      | DbRow
      | undefined;
    return row ? this.rowToSnapshotMeta(row) : null;
  }

  latestSnapshotId(): string | null {
    const row = this.db.prepare("SELECT id FROM snapshots ORDER BY created_at DESC LIMIT 1").get() as
      | DbRow
      | undefined;
    return row ? String(row.id) : null;
  }

  getSnapshotMeta(ref: string): SnapshotMeta | null {
    const row = this.findSnapshotRow(ref);
    return row ? this.rowToSnapshotMeta(row) : null;
  }

  pinSnapshot(ref: string, pinned = true): void {
    const row = this.findSnapshotRow(ref);
    if (!row) throw new Error(`Snapshot not found: ${ref}`);
    this.db.prepare("UPDATE snapshots SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, String(row.id));
  }

  deleteSnapshot(ref: string): boolean {
    const row = this.findSnapshotRow(ref);
    if (!row) return false;
    this.db.prepare("DELETE FROM snapshots WHERE id = ?").run(String(row.id));
    return true;
  }

  private findSnapshotRow(ref: string): DbRow | undefined {
    if (ref === "latest" || ref === "-1") {
      return this.db.prepare("SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1").get() as
        | DbRow
        | undefined;
    }
    const exact = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(ref) as DbRow | undefined;
    if (exact) return exact;
    if (/^[A-Za-z0-9-]+$/.test(ref)) {
      const prefix = this.db
        .prepare("SELECT * FROM snapshots WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
        .get(`${ref}%`) as DbRow | undefined;
      if (prefix) return prefix;
    }
    const label = this.db
      .prepare("SELECT * FROM snapshots WHERE label = ? ORDER BY created_at DESC LIMIT 1")
      .get(ref) as DbRow | undefined;
    return label;
  }

  private rowToSnapshotMeta(row: DbRow): SnapshotMeta {
    const warnings = parseJson<SnapshotWarning[]>(String(row.warnings_json), []);
    const host = parseJson<SnapshotMeta["host"]>(String(row.host_json ?? "{}"), {
      hostname: "",
      os: "",
      version: "",
      build: "",
    });
    return {
      id: String(row.id),
      createdAt: Number(row.created_at),
      label: row.label ? String(row.label) : null,
      trigger: String(row.trigger) as SnapshotMeta["trigger"],
      profile: String(row.profile) as SnapshotMeta["profile"],
      dataHash: String(row.data_hash),
      sizeBytes: Number(row.size_bytes),
      durationMs: Number(row.duration_ms),
      warnings,
      pinned: Boolean(row.pinned),
      host,
    };
  }

  saveRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs
          (id, command, command_signature, cwd, project_id, pre_snapshot, post_snapshot, exit_code, signal,
           started_at, duration_ms, stderr_tail, stdout_tail, reference_snapshot, change_signatures_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.command,
        run.commandSignature,
        run.cwd,
        run.projectId ?? null,
        run.preSnapshot,
        run.postSnapshot ?? null,
        run.exitCode ?? null,
        run.signal ?? null,
        run.startedAt,
        run.durationMs,
        run.stderrTail ?? null,
        run.stdoutTail ?? null,
        run.referenceSnapshot ?? null,
        JSON.stringify(run.changeSignatures),
      );
  }

  updateRun(
    id: string,
    patch: {
      postSnapshot?: string | null;
      exitCode?: number | null;
      signal?: string | null;
      durationMs?: number;
      stderrTail?: string | null;
      stdoutTail?: string | null;
      referenceSnapshot?: string | null;
      changeSignatures?: string[];
    },
  ): void {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    this.saveRun({
      ...current,
      postSnapshot: patch.postSnapshot === undefined ? current.postSnapshot : patch.postSnapshot,
      exitCode: patch.exitCode === undefined ? current.exitCode : patch.exitCode,
      signal: patch.signal === undefined ? current.signal : patch.signal,
      durationMs: patch.durationMs ?? current.durationMs,
      stderrTail: patch.stderrTail === undefined ? current.stderrTail : patch.stderrTail,
      stdoutTail: patch.stdoutTail === undefined ? current.stdoutTail : patch.stdoutTail,
      referenceSnapshot:
        patch.referenceSnapshot === undefined ? current.referenceSnapshot : patch.referenceSnapshot,
      changeSignatures: patch.changeSignatures ?? current.changeSignatures,
    });
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.rowToRun(row) : null;
  }

  findRun(ref: string): RunRecord | null {
    const exact = this.getRun(ref);
    if (exact) return exact;
    if (!/^[A-Za-z0-9-]+$/.test(ref)) return null;
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id LIKE ? ORDER BY started_at DESC LIMIT 1")
      .get(`${ref}%`) as DbRow | undefined;
    return row ? this.rowToRun(row) : null;
  }

  listRuns(limit = 50, offset = 0): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as DbRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  runsForProject(projectId: string, limit = 20): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(projectId, limit) as DbRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  lastSuccess(projectId: string | null, commandSignature: string): RunRecord | null {
    const row = projectId
      ? (this.db
          .prepare(
            `SELECT * FROM runs
             WHERE project_id = ? AND command_signature = ? AND exit_code = 0 AND post_snapshot IS NOT NULL
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(projectId, commandSignature) as DbRow | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM runs
             WHERE command_signature = ? AND exit_code = 0 AND post_snapshot IS NOT NULL
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(commandSignature) as DbRow | undefined);
    return row ? this.rowToRun(row) : null;
  }

  findReference(
    projectId: string | null,
    commandSignature: string,
    beforeStartedAt = Date.now(),
  ): ReferenceInfo {
    const success = this.lastSuccess(projectId, commandSignature);
    if (success?.postSnapshot) {
      return {
        snapshotId: success.postSnapshot,
        source: "last-success",
        runId: success.id,
        at: success.startedAt,
      };
    }
    const active = this.getActiveBaseline();
    if (active) {
      return { snapshotId: active.snapshotId, source: "baseline", at: active.createdAt };
    }
    const row = this.db
      .prepare("SELECT id, created_at FROM snapshots WHERE created_at <= ? ORDER BY created_at DESC LIMIT 1")
      .get(beforeStartedAt) as DbRow | undefined;
    if (row) {
      return { snapshotId: String(row.id), source: "latest", at: Number(row.created_at) };
    }
    return { snapshotId: null, source: "none" };
  }

  private rowToRun(row: DbRow): RunRecord {
    return {
      id: String(row.id),
      command: String(row.command),
      commandSignature: String(row.command_signature),
      cwd: String(row.cwd),
      projectId: row.project_id ? String(row.project_id) : null,
      preSnapshot: String(row.pre_snapshot),
      postSnapshot: row.post_snapshot ? String(row.post_snapshot) : null,
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
      signal: row.signal ? String(row.signal) : null,
      startedAt: Number(row.started_at),
      durationMs: Number(row.duration_ms),
      stderrTail: row.stderr_tail ? String(row.stderr_tail) : null,
      stdoutTail: row.stdout_tail ? String(row.stdout_tail) : null,
      referenceSnapshot: row.reference_snapshot ? String(row.reference_snapshot) : null,
      changeSignatures: parseJson<string[]>(String(row.change_signatures_json), []),
    };
  }

  recordChangeObservation(changes: Change[], failed: boolean): void {
    if (changes.length === 0) {
      this.db
        .prepare(
          `UPDATE change_stats
           SET runs_absent = runs_absent + 1, fails_absent = fails_absent + ?1, last_seen = ?2`,
        )
        .run(failed ? 1 : 0, Date.now());
      return;
    }
    const seen = new Set(changes.map((change) => change.signature));
    this.transaction(() => {
      const existing = this.db.prepare("SELECT signature FROM change_stats").all() as DbRow[];
      const absent = this.db.prepare(
        `UPDATE change_stats
         SET runs_absent = runs_absent + 1, fails_absent = fails_absent + ?1
         WHERE signature = ?2`,
      );
      for (const row of existing) {
        if (!seen.has(String(row.signature))) absent.run(failed ? 1 : 0, String(row.signature));
      }
      const present = this.db.prepare(
        `INSERT INTO change_stats
          (signature, category, path, runs_present, fails_present, runs_absent, fails_absent, last_seen)
         VALUES (?1, ?2, ?3, 1, ?4, 0, 0, ?5)
         ON CONFLICT(signature) DO UPDATE SET
           runs_present = runs_present + 1,
           fails_present = fails_present + ?4,
           last_seen = ?5`,
      );
      const now = Date.now();
      for (const change of changes) {
        present.run(change.signature, change.category, change.path, failed ? 1 : 0, now);
      }
    });
  }

  getChangeStats(signatures: string[]): Record<string, ChangeStats> {
    if (signatures.length === 0) return {};
    const placeholders = signatures.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM change_stats WHERE signature IN (${placeholders})`)
      .all(...signatures) as DbRow[];
    const out: Record<string, ChangeStats> = {};
    for (const row of rows) {
      const stats: ChangeStats = {
        signature: String(row.signature),
        category: String(row.category) as ChangeStats["category"],
        path: String(row.path),
        runsPresent: Number(row.runs_present),
        failsPresent: Number(row.fails_present),
        runsAbsent: Number(row.runs_absent),
        failsAbsent: Number(row.fails_absent),
        lastSeen: Number(row.last_seen),
      };
      out[stats.signature] = stats;
    }
    return out;
  }

  correlationFor(signature: string): {
    runsPresent: number;
    failsPresent: number;
    runsAbsent: number;
    failsAbsent: number;
    lift: number;
    eligible: boolean;
  } {
    const stats = this.getChangeStats([signature])[signature];
    if (!stats) {
      return { runsPresent: 0, failsPresent: 0, runsAbsent: 0, failsAbsent: 0, lift: 0, eligible: false };
    }
    const presentRate = (stats.failsPresent + 1) / (stats.runsPresent + 2);
    const absentRate = (stats.failsAbsent + 1) / (stats.runsAbsent + 2);
    const eligible = stats.runsPresent >= 3 && stats.runsAbsent >= 3;
    const lift = eligible ? Math.max(-0.5, Math.min(0.5, presentRate - absentRate)) : 0;
    return {
      runsPresent: stats.runsPresent,
      failsPresent: stats.failsPresent,
      runsAbsent: stats.runsAbsent,
      failsAbsent: stats.failsAbsent,
      lift,
      eligible,
    };
  }

  saveCase(record: CaseRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cases
          (id, title, status, created_at, closed_at, run_id, reference_snapshot, findings_json, summary, rollback_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.title,
        record.status,
        record.createdAt,
        record.closedAt,
        record.runId,
        record.referenceSnapshot,
        JSON.stringify(record.findings),
        record.summary,
        record.rollbackId,
      );
  }

  getCase(ref: string): CaseRecord | null {
    const exact = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(ref) as DbRow | undefined;
    const row =
      exact ??
      (this.db
        .prepare("SELECT * FROM cases WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
        .get(`${ref}%`) as DbRow | undefined);
    return row ? this.rowToCase(row) : null;
  }

  caseForRun(runId: string): CaseRecord | null {
    const row = this.db
      .prepare("SELECT * FROM cases WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId) as DbRow | undefined;
    return row ? this.rowToCase(row) : null;
  }

  listCases(limit = 50, offset = 0): CaseRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM cases ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as DbRow[];
    return rows.map((row) => this.rowToCase(row));
  }

  openCases(): CaseRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM cases WHERE status = 'open' ORDER BY created_at DESC")
      .all() as DbRow[];
    return rows.map((row) => this.rowToCase(row));
  }

  closeCase(ref: string, summary?: string): void {
    const record = this.getCase(ref);
    if (!record) throw new Error(`Case not found: ${ref}`);
    this.db
      .prepare("UPDATE cases SET status = 'closed', closed_at = ?, summary = COALESCE(?, summary) WHERE id = ?")
      .run(Date.now(), summary ?? null, record.id);
  }

  setCaseRollback(caseRef: string, rollbackId: string): void {
    const record = this.getCase(caseRef);
    if (!record) throw new Error(`Case not found: ${caseRef}`);
    this.db.prepare("UPDATE cases SET rollback_id = ? WHERE id = ?").run(rollbackId, record.id);
  }

  private rowToCase(row: DbRow): CaseRecord {
    return {
      id: String(row.id),
      title: String(row.title),
      status: String(row.status) as CaseRecord["status"],
      createdAt: Number(row.created_at),
      closedAt: row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at),
      runId: String(row.run_id),
      referenceSnapshot: String(row.reference_snapshot),
      findings: parseJson<Finding[]>(String(row.findings_json), []),
      summary: row.summary ? String(row.summary) : "",
      rollbackId: row.rollback_id ? String(row.rollback_id) : null,
    };
  }

  setBaseline(snapshotId: string, label = "Known good", createdAt = Date.now()): BaselineRecord {
    const record: BaselineRecord = {
      id: baselineId(snapshotId),
      label,
      snapshotId,
      createdAt,
      active: true,
    };
    this.transaction(() => {
      this.db.prepare("UPDATE baselines SET active = 0").run();
      this.db
        .prepare(
          `INSERT OR REPLACE INTO baselines (id, label, snapshot_id, created_at, active)
           VALUES (?, ?, ?, ?, 1)`,
        )
        .run(record.id, record.label, record.snapshotId, record.createdAt);
    });
    return record;
  }

  getActiveBaseline(): BaselineRecord | null {
    const row = this.db
      .prepare("SELECT * FROM baselines WHERE active = 1 ORDER BY created_at DESC LIMIT 1")
      .get() as DbRow | undefined;
    return row ? this.rowToBaseline(row) : null;
  }

  listBaselines(limit = 50): BaselineRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM baselines ORDER BY created_at DESC LIMIT ?")
      .all(limit) as DbRow[];
    return rows.map((row) => this.rowToBaseline(row));
  }

  deactivateBaseline(): void {
    this.db.prepare("UPDATE baselines SET active = 0").run();
  }

  private rowToBaseline(row: DbRow): BaselineRecord {
    return {
      id: String(row.id),
      label: row.label ? String(row.label) : "",
      snapshotId: String(row.snapshot_id),
      createdAt: Number(row.created_at),
      active: Boolean(row.active),
    };
  }

  saveRollback(record: RollbackRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rollbacks
          (id, created_at, case_id, run_id, plan_json, status, safety_snapshot, log_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.createdAt,
        record.caseId,
        record.runId,
        JSON.stringify(record.plan),
        record.status,
        record.safetySnapshot,
        JSON.stringify(record.log),
      );
  }

  getRollback(ref: string): RollbackRecord | null {
    const exact = this.db.prepare("SELECT * FROM rollbacks WHERE id = ?").get(ref) as DbRow | undefined;
    const row =
      exact ??
      (this.db
        .prepare("SELECT * FROM rollbacks WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1")
        .get(`${ref}%`) as DbRow | undefined);
    return row ? this.rowToRollback(row) : null;
  }

  listRollbacks(limit = 50): RollbackRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM rollbacks ORDER BY created_at DESC LIMIT ?")
      .all(limit) as DbRow[];
    return rows.map((row) => this.rowToRollback(row));
  }

  private rowToRollback(row: DbRow): RollbackRecord {
    return {
      id: String(row.id),
      createdAt: Number(row.created_at),
      caseId: row.case_id ? String(row.case_id) : null,
      runId: row.run_id ? String(row.run_id) : null,
      plan: parseJson<RollbackRecord["plan"]>(String(row.plan_json), {
        id: String(row.id),
        createdAt: Number(row.created_at),
        caseId: null,
        runId: null,
        targetSnapshot: null,
        currentSnapshot: null,
        actions: [],
        manual: [],
        warnings: [],
      }),
      status: String(row.status) as RollbackRecord["status"],
      safetySnapshot: row.safety_snapshot ? String(row.safety_snapshot) : null,
      log: parseJson<RollbackRecord["log"]>(String(row.log_json), []),
    };
  }

  logEvent(type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (at, type, payload_json) VALUES (?, ?, ?)")
      .run(Date.now(), type, JSON.stringify(payload));
  }

  listEvents(limit = 100): Array<{ id: number; at: number; type: string; payload: unknown }> {
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY at DESC LIMIT ?")
      .all(limit) as DbRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      type: String(row.type),
      payload: parseJson<unknown>(String(row.payload_json), null),
    }));
  }

  protectedSnapshotIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT snapshot_id AS id FROM baselines
         UNION SELECT reference_snapshot AS id FROM cases
         UNION SELECT pre_snapshot AS id FROM runs
         UNION SELECT post_snapshot AS id FROM runs WHERE post_snapshot IS NOT NULL
         UNION SELECT reference_snapshot AS id FROM runs WHERE reference_snapshot IS NOT NULL
         UNION SELECT safety_snapshot AS id FROM rollbacks WHERE safety_snapshot IS NOT NULL
         UNION SELECT id FROM snapshots WHERE pinned = 1`,
      )
      .all() as DbRow[];
    return new Set(rows.map((row) => String(row.id)).filter(Boolean));
  }

  prune(options: { keep?: number; olderThanDays?: number; dryRun?: boolean } = {}): PruneResult {
    const keep = Math.max(1, Math.floor(options.keep ?? 50));
    const olderThanDays = Math.max(0, options.olderThanDays ?? 30);
    const dryRun = options.dryRun !== false;
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    const rows = this.db.prepare("SELECT * FROM snapshots ORDER BY created_at DESC").all() as DbRow[];
    const protectedIds = this.protectedSnapshotIds();
    const keepIds = new Set(rows.slice(0, keep).map((row) => String(row.id)));
    const candidates = rows
      .filter((row) => {
        const id = String(row.id);
        return !protectedIds.has(id) && !keepIds.has(id) && Number(row.created_at) < cutoff;
      })
      .map((row) => this.rowToSnapshotMeta(row));
    let bytesFreed = candidates.reduce((sum, item) => sum + item.sizeBytes, 0);
    if (!dryRun && candidates.length > 0) {
      const hashes = candidates.map((item) => item.dataHash);
      const placeholders = candidates.map(() => "?").join(",");
      this.transaction(() => {
        this.db
          .prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`)
          .run(...candidates.map((item) => item.id));
      });
      for (const hash of hashes) {
        const remaining = this.db
          .prepare("SELECT COUNT(*) AS n FROM snapshots WHERE data_hash = ?")
          .get(hash) as DbRow;
        if (Number(remaining.n) === 0 && existsSync(this.blobPath(hash))) {
          unlinkSync(this.blobPath(hash));
        }
      }
    }
    return {
      dryRun,
      candidates,
      snapshotsDeleted: dryRun ? 0 : candidates.length,
      bytesFreed,
      protectedCount: protectedIds.size,
    };
  }

  getStats(): StoreStats {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as DbRow;
      return Number(row.n);
    };
    const dbBytes = [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`].reduce((sum, file) => {
      try {
        return sum + statSync(file).size;
      } catch {
        return sum;
      }
    }, 0);
    return {
      snapshots: count("snapshots"),
      runs: count("runs"),
      cases: count("cases"),
      rollbacks: count("rollbacks"),
      bytes: dbBytes + directorySize(this.objectsDir),
    };
  }

  isInitialized(): boolean {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | DbRow
      | undefined;
    return Boolean(row);
  }
}

function parseJson<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

function directorySize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(full);
      else total += statSync(full).size;
    } catch {
      // Ignore files that disappear during the walk.
    }
  }
  return total;
}

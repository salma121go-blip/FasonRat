import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../db/seed.js';
import { getRequestUser } from '../middleware/auth.js';
import { getDb, dbHelpers } from '../db/index.js';
import { users, sessions } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { validateUsername, validatePasswordStrength, validateEmail } from '../utils/helpers.js';
import type { JwtPayload, UserRole } from '../types/index.js';
import { resolvePermissions } from '../types/index.js';
import { log } from '../utils/logger.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const { username, password } = (request.body || {}) as { username?: string; password?: string };
    const config = getConfig();
    const ip = request.ip;

    const identifier = username ? `${ip}|${username.toLowerCase()}` : ip;

    if (!username || !password) {
      return reply.code(400).send({ success: false, error: 'Username/email and password are required' });
    }

    if (dbHelpers.checkLoginAttempts(ip, config.security.loginAttempts, config.security.loginLockout, identifier)) {
      dbHelpers.addLog('AUTH', 'SECURITY', `Login locked out for IP: ${ip}, identifier: ${identifier}`);
      return reply.code(429).send({ success: false, error: 'Too many login attempts. Try again later.' });
    }

    const user = dbHelpers.getUserByUsernameOrEmail(username);

    if (!user || !(await verifyPassword(password, user.password))) {
      dbHelpers.recordLoginAttempt(ip, identifier);
      dbHelpers.addLog('AUTH', 'LOGIN', `Failed login attempt for: ${username}`, JSON.stringify({ ip }));
      return reply.code(401).send({ success: false, error: 'Invalid credentials' });
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + config.security.sessionTimeout).toISOString();

    const d = getDb();
    d.insert(sessions).values({
      token: sessionToken,
      userId: user.id,
      ip,
      expiresAt,
    }).run();

    d.update(users).set({ lastLogin: new Date().toISOString() }).where(eq(users.id, user.id)).run();

    const permissions = resolvePermissions(user.role as UserRole, user.permissions);
    const jwtPayload: JwtPayload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role as UserRole,
      permissions,
      sessionId: sessionToken,
    };
    const jwtExpiry = Math.floor(config.security.sessionTimeout / 1000) + 's';
    const jwtToken = app.jwt.sign(jwtPayload, { expiresIn: jwtExpiry });

    const rawXfp = request.headers['x-forwarded-proto'];
    const xfpStr = Array.isArray(rawXfp) ? rawXfp[0] ?? '' : rawXfp ?? '';
    const xfp = xfpStr.toLowerCase();
    const isSecure = request.protocol === 'https'
      || xfp === 'https'
      || xfp.split(',')[0].trim() === 'https';
    reply.setCookie('token', jwtToken, {
      path: '/',
      httpOnly: true,
      secure: isSecure,
      maxAge: config.security.sessionTimeout / 1000,
      sameSite: 'lax',
    });

    dbHelpers.addLog('AUTH', 'LOGIN', `User ${user.username} logged in`, JSON.stringify({ ip, role: user.role }));

    return {
      success: true,
      data: {
        id: user.id,
        token: jwtToken,
        username: user.username,
        email: user.email,
        role: user.role,
        permissions,
      },
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    let username: string | undefined;
    try {
      const token = request.cookies.token || (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.substring(7) : undefined);
      if (token) {
        const decoded = request.server.jwt.verify(token) as JwtPayload;
        username = decoded.username;
        const d = getDb();
        if (decoded.sessionId) {
          d.delete(sessions).where(eq(sessions.token, decoded.sessionId)).run();
        } else {
          d.delete(sessions).where(eq(sessions.userId, decoded.userId)).run();
        }
      }
    } catch { /* ignore */ }

    reply.clearCookie('token', { path: '/' });

    if (username) {
      dbHelpers.addLog('AUTH', 'LOGOUT', `User ${username} logged out`);
    }

    return { success: true };
  });

  app.get('/api/auth/me', {
    preHandler: [app.auth],
  }, async (request, reply) => {
    const user = getRequestUser(request);
    const dbUser = dbHelpers.getUserById(user.userId);
    if (!dbUser) {
      return reply.code(404).send({ success: false, error: 'User not found' });
    }
    const permissions = resolvePermissions(dbUser.role as UserRole, dbUser.permissions);
    return {
      success: true,
      data: {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email,
        role: dbUser.role,
        permissions,
      },
    };
  });

  app.get('/api/auth/sessions', {
    preHandler: [app.auth],
  }, async (request) => {
    const user = getRequestUser(request);
    const d = getDb();
    const nowIso = new Date().toISOString();

    const rows = user.role === 'admin'
      ? d.select({
          id: sessions.id,
          token: sessions.token,
          userId: sessions.userId,
          username: users.username,
          ip: sessions.ip,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
        }).from(sessions)
          .leftJoin(users, eq(users.id, sessions.userId))
          .where(sql`${sessions.expiresAt} > ${nowIso}`)
          .orderBy(sessions.createdAt)
          .all()
      : d.select({
          id: sessions.id,
          token: sessions.token,
          userId: sessions.userId,
          username: users.username,
          ip: sessions.ip,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
        }).from(sessions)
          .leftJoin(users, eq(users.id, sessions.userId))
          .where(sql`${sessions.userId} = ${user.userId} AND ${sessions.expiresAt} > ${nowIso}`)
          .orderBy(sessions.createdAt)
          .all();

    const data = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      username: r.username,
      ip: r.ip,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      tokenPreview: r.token ? r.token.slice(0, 8) + '…' : '',
      isCurrent: user.sessionId === r.token,
    }));

    return { success: true, data };
  });

  app.delete('/api/auth/sessions/:id', {
    preHandler: [app.auth],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const sessionIdNum = parseInt(id, 10);
    if (isNaN(sessionIdNum)) {
      return reply.code(400).send({ success: false, error: 'Invalid session id' });
    }

    const user = getRequestUser(request);
    const d = getDb();
    const row = d.select({ id: sessions.id, userId: sessions.userId, token: sessions.token })
      .from(sessions).where(eq(sessions.id, sessionIdNum)).get();

    if (!row) {
      return reply.code(404).send({ success: false, error: 'Session not found' });
    }

    if (user.role !== 'admin' && row.userId !== user.userId) {
      return reply.code(403).send({ success: false, error: 'Cannot revoke another user\'s session' });
    }

    if (row.token === user.sessionId) {
      return reply.code(400).send({ success: false, error: 'Cannot revoke your current session — use logout instead' });
    }

    d.delete(sessions).where(eq(sessions.id, sessionIdNum)).run();
    dbHelpers.addLog('AUTH', 'SESSION', `Session ${sessionIdNum} revoked by ${user.username}`);
    return { success: true };
  });

  app.post('/api/auth/change-password', {
    preHandler: [app.auth],
  }, async (request, reply) => {
    const { currentPassword, newPassword } = (request.body || {}) as { currentPassword?: string; newPassword?: string };
    const user = getRequestUser(request);

    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ success: false, error: 'Current password and new password are required' });
    }

    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.valid) {
      return reply.code(400).send({ success: false, error: passwordValidation.message });
    }

    const dbUser = dbHelpers.getUserById(user.userId);
    if (!dbUser) {
      return reply.code(404).send({ success: false, error: 'User not found' });
    }

    const isValid = await verifyPassword(currentPassword, dbUser.password);
    if (!isValid) {
      return reply.code(401).send({ success: false, error: 'Current password is incorrect' });
    }

    const hash = await hashPassword(newPassword);
    dbHelpers.updateUserPassword(user.userId, hash);

    const d = getDb();
    if (user.sessionId) {
      d.delete(sessions).where(sql`${sessions.userId} = ${user.userId} AND ${sessions.token} != ${user.sessionId}`).run();
    } else {
      d.delete(sessions).where(eq(sessions.userId, user.userId)).run();
    }

    dbHelpers.addLog('AUTH', 'PASSWORD', `User ${user.username} changed their password`);

    return { success: true, message: 'Password changed successfully' };
  });

  app.post('/api/auth/update-profile', {
    preHandler: [app.auth],
  }, async (request, reply) => {
    const { username, email } = (request.body || {}) as { username?: string; email?: string };
    const user = getRequestUser(request);

    const updates: { username?: string; email?: string } = {};

    if (username !== undefined) {
      const validation = validateUsername(username);
      if (!validation.valid) {
        return reply.code(400).send({ success: false, error: validation.message });
      }
      const d = getDb();
      const existing = d.select({ id: users.id }).from(users).where(sql`LOWER(${users.username}) = ${username.toLowerCase()} AND ${users.id} != ${user.userId}`).get();
      if (existing) {
        return reply.code(409).send({ success: false, error: 'Username already taken' });
      }
      updates.username = username.toLowerCase();
    }

    if (email !== undefined) {
      const validation = validateEmail(email);
      if (!validation.valid) {
        return reply.code(400).send({ success: false, error: validation.message });
      }
      const d = getDb();
      const existing = d.select({ id: users.id }).from(users).where(sql`LOWER(${users.email}) = ${email.toLowerCase()} AND ${users.id} != ${user.userId}`).get();
      if (existing) {
        return reply.code(409).send({ success: false, error: 'Email already taken' });
      }
      updates.email = email.toLowerCase();
    }

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ success: false, error: 'No fields to update' });
    }

    dbHelpers.updateUser(user.userId, updates);

    dbHelpers.addLog('AUTH', 'PROFILE', `User ${user.username} updated their profile`, JSON.stringify(updates));

    return { success: true, message: 'Profile updated successfully' };
  });
}

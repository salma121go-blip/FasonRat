import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { settings } from '../db/schema.js';
import { getConfig, updateConfig, parseConfigValue } from '../config/index.js';
import { requirePermission } from '../middleware/auth.js';
import { dbHelpers } from '../db/index.js';
import { log } from '../utils/logger.js';

const ALLOWED_KEYS = [
  'logger.console.enabled',
];

const DEVICE_SECRET_MIN_LEN = 8;
const DEVICE_SECRET_MAX_LEN = 256;

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/config', {
    preHandler: [app.auth, requirePermission('settings:view')],
  }, async () => {
    const cfg = getConfig();

    return {
      success: true,
      data: {
        ...cfg,
        security: {
          ...cfg.security,
          deviceSecret: cfg.security.deviceSecret || '',
          deviceSecretEnabled: !!cfg.security.deviceSecret,
        },
      },
    };
  });

  app.post('/api/config', {
    preHandler: [app.auth, requirePermission('settings:edit')],
  }, async (request, reply) => {
    const { key, value } = (request.body || {}) as { key?: string; value?: string };

    if (!key || value == null) {
      return reply.code(400).send({ success: false, error: 'Key and value are required' });
    }

    if (!ALLOWED_KEYS.includes(key)) {
      return reply.code(403).send({ success: false, error: 'This setting cannot be changed from the UI' });
    }

    const parsedValue = parseConfigValue(value);
    updateConfig(key, parsedValue);

    const stringValue = String(value);
    getDb().insert(settings).values({ key, value: stringValue })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: stringValue, updatedAt: new Date().toISOString() },
      }).run();

    return { success: true, key, value: parsedValue };
  });

  app.post('/api/config/device-secret', {
    preHandler: [app.auth, requirePermission('settings:edit')],
  }, async (request, reply) => {
    const { value } = (request.body || {}) as { value?: unknown };
    const key = 'security.deviceSecret';

    if (value != null && typeof value !== 'string') {
      return reply.code(400).send({ success: false, error: 'Secret value must be a string' });
    }
    const secretValue = typeof value === 'string' ? value : '';

    if (secretValue && secretValue.length > 0) {
      if (secretValue.length < DEVICE_SECRET_MIN_LEN) {
        return reply.code(400).send({ success: false, error: `Secret must be at least ${DEVICE_SECRET_MIN_LEN} characters` });
      }
      if (secretValue.length > DEVICE_SECRET_MAX_LEN) {
        return reply.code(400).send({ success: false, error: `Secret must be at most ${DEVICE_SECRET_MAX_LEN} characters` });
      }

      if (/[\r\n=]/.test(secretValue)) {
        return reply.code(400).send({ success: false, error: 'Secret must not contain newlines or "=" characters' });
      }
      updateConfig(key, secretValue);
      getDb().insert(settings).values({ key, value: secretValue })
        .onConflictDoUpdate({ target: settings.key, set: { value: secretValue, updatedAt: new Date().toISOString() } })
        .run();
      log.warn('Device authentication secret enabled by admin');
      dbHelpers.addLog('SECURITY', 'CONFIG', 'Device authentication secret enabled');
      return { success: true, enabled: true };
    } else {
      updateConfig(key, '');
      getDb().insert(settings).values({ key, value: '' })
        .onConflictDoUpdate({ target: settings.key, set: { value: '', updatedAt: new Date().toISOString() } })
        .run();
      log.warn('Device authentication secret disabled by admin');
      dbHelpers.addLog('SECURITY', 'CONFIG', 'Device authentication secret disabled');
      return { success: true, enabled: false };
    }
  });
}

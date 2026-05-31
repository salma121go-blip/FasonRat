import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getConfig, updateConfig, parseConfigValue } from '../config/index.js';
import { requirePermission } from '../middleware/auth.js';

const ALLOWED_KEYS = [
  'logger.console.enabled',
];

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/config', {
    preHandler: [app.auth, requirePermission('settings:view')],
  }, async () => {
    return { success: true, data: getConfig() };
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

    const d = getDb();
    const existing = d.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).get();
    if (existing) {
      d.update(settings).set({ value: String(value), updatedAt: new Date().toISOString() }).where(eq(settings.key, key)).run();
    } else {
      d.insert(settings).values({ key, value: String(value) }).run();
    }

    return { success: true, key, value: parsedValue };
  });
}

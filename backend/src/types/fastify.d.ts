import { authMiddleware } from '../middleware/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: typeof authMiddleware;
  }
}

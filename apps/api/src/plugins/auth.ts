import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { AuthService } from '../services/auth/index.js';
import { readSessionToken, setSessionCookie } from './auth-helpers.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser: import('../services/auth/index.js').AuthContext | null;
  }
}

/**
 * Resolves the session cookie into `request.authUser` for every request.
 * No route handler reads cookies directly — authorization always goes through
 * this resolver, which validates the hashed token against the sessions table.
 */
export default fp<{ auth: AuthService; sessionTtlDays: number; cookieSecure: boolean; cookieDomain?: string }>(
  async function authPlugin(instance: FastifyInstance, options) {
    instance.decorateRequest('authUser', null);
    instance.addHook('onRequest', async (request, reply) => {
      const token = readSessionToken(request);
      if (!token) return;
      try {
        const resolved = await options.auth.resolveSession(token);
        if (!resolved) return;
        request.authUser = {
          userId: resolved.user.id,
          email: resolved.user.email,
          role: resolved.user.role,
        };
        if (resolved.renewedExpiry) {
          setSessionCookie(reply, token, resolved.renewedExpiry, {
            secure: options.cookieSecure,
            domain: options.cookieDomain,
            ttlDays: options.sessionTtlDays,
          });
        }
      } catch (error) {
        request.log.warn({ err: (error as Error).message }, 'session resolution failed');
      }
    });
  },
  { name: 'formaai-auth' },
);

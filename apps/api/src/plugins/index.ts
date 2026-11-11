import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import authPlugin from './auth.js';
import errorHandler from './errors.js';
import type { AuthService } from '../services/auth/index.js';
import type { AppConfig } from '../config.js';

export interface ServerPluginsOptions {
  config: AppConfig;
  auth: AuthService;
}

export async function registerPlugins(instance: FastifyInstance, options: ServerPluginsOptions): Promise<void> {
  const { config, auth } = options;

  await instance.register(errorHandler);
  await instance.register(fastifyCookie);
  await instance.register(fastifyMultipart, {
    limits: {
      fileSize: config.MAX_FILE_MB * 1024 * 1024,
      files: 1,
      fields: 10,
      parts: 12,
    },
    throwFileSizeLimit: true,
  });
  await instance.register(fastifyRateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    allowList: [],
    keyGenerator: (request) => request.authUser?.userId ?? request.ip,
    // @fastify/rate-limit *throws* whatever this returns, so it must carry
    // `statusCode` for the error handler to answer 429 rather than 500.
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error('Too many requests. Please slow down and try again shortly.'), {
        statusCode: 429,
        code: 'RATE_LIMITED',
        after: context.after,
      }),
  });
  await instance.register(authPlugin, {
    auth,
    sessionTtlDays: config.SESSION_TTL_DAYS,
    cookieSecure: config.COOKIE_SECURE,
    cookieDomain: config.COOKIE_DOMAIN,
  });

  instance.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');

    // CSRF defence for cookie-authenticated state changes: browsers always send
    // Origin on cross-site POST/PATCH/DELETE; reject anything not allow-listed.
    const method = request.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const origin = request.headers.origin;
      if (origin && !config.webOrigins.includes(origin)) {
        // Operator-facing hint: this is almost always a WEB_ORIGIN mismatch (e.g.
        // the app is reached on a different port than WEB_ORIGIN advertises), not
        // an attack. Naming the expected origin makes that immediately fixable.
        request.log.warn(
          { origin, allowed: config.webOrigins },
          'blocked a state-changing request from an origin not in WEB_ORIGIN',
        );
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message:
              `Cross-origin request blocked: this app is reached from ${origin}, ` +
              `but the server's WEB_ORIGIN is set to ${config.webOrigins.join(', ')}. ` +
              `Set WEB_ORIGIN to the URL you use in the browser and restart the API.`,
          },
        });
      }
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
  }
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../services/auth/index.js';
import { badRequest, unauthorized } from '../lib/http-errors.js';
import type { z } from 'zod';
import { validationError } from '../lib/errors.js';

export const SESSION_COOKIE = 'formaai_session';

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  options: { secure: boolean; domain?: string; ttlDays: number },
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    domain: options.domain,
    expires: expiresAt,
    maxAge: options.ttlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, domain?: string): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', domain });
}

export function readSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies?.[SESSION_COOKIE];
}

/** Returns the authenticated context or throws 401. */
export function requireUser(request: FastifyRequest): AuthContext {
  if (!request.authUser) throw unauthorized();
  return request.authUser;
}

export function optionalUser(request: FastifyRequest): AuthContext | null {
  return request.authUser ?? null;
}

/** Parses a request body with a Zod schema and throws a 422 with issue details. */
export function parseBody<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  const result = schema.safeParse(request.body ?? {});
  if (!result.success) {
    throw validationError(
      'Some fields are invalid',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export function parseQuery<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  const result = schema.safeParse(request.query ?? {});
  if (!result.success) {
    throw validationError(
      'Invalid query parameters',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export function parseParams<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  const result = schema.safeParse(request.params ?? {});
  if (!result.success) {
    throw badRequest('Invalid route parameters');
  }
  return result.data;
}

export function registerAuthenticator(instance: FastifyInstance): void {
  instance.decorateRequest('authUser', null);
}

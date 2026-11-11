import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { ProviderError } from '@formaai/ai-providers';
import { DocxPackageError } from '@formaai/docx-engine';

/**
 * Converts thrown errors into a stable JSON envelope:
 *   { error: { code, message, details?, requestId } }
 *
 * Internal errors never leak stack traces or provider payload internals to the
 * client; they are logged with the same requestId for correlation.
 */
export default fp(async function errorHandler(instance: FastifyInstance) {
  instance.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      if (error.status >= 500) {
        request.log.error({ err: error, requestId, code: error.code }, 'request failed');
      }
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details, requestId },
      });
    }
    if (error instanceof ProviderError) {
      request.log.warn({ requestId, code: error.code }, 'provider error');
      return reply.status(error.code === 'AUTH_FAILED' ? 502 : 502).send({
        error: { code: `PROVIDER_${error.code}`, message: error.message, requestId },
      });
    }
    if (error instanceof DocxPackageError) {
      return reply.status(422).send({
        error: { code: 'INVALID_DOCUMENT', message: error.message, requestId },
      });
    }
    // Fastify built-ins (body validation, payload limits, rate limits)
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large', requestId },
      });
    }
    if (statusCode === 429 || (error as { code?: string }).code === 'RATE_LIMITED') {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: (error as Error).message || 'Too many requests. Please slow down.',
          requestId,
        },
      });
    }
    if (statusCode === 400) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: (error as Error).message, requestId },
      });
    }
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: 'REQUEST_FAILED', message: (error as Error).message, requestId },
      });
    }

    const jobErrorCode = (error as { code?: string }).code;
    request.log.error(
      {
        requestId,
        err: { message: (error as Error).message, name: (error as Error).name, code: jobErrorCode },
      },
      'unhandled error',
    );
    const isProduction = process.env.NODE_ENV === 'production';
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: isProduction
          ? 'Something went wrong on the server. The issue has been logged.'
          : (error as Error).message,
        requestId,
      },
    });
  });

  instance.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found`, requestId: request.id },
    });
  });
});

export function originIsAllowed(request: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // same-origin or non-browser client
  return allowedOrigins.includes(origin);
}

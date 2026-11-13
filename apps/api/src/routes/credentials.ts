import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { providerCredentialCreateSchema, providerCredentialUpdateSchema, providerFallbackSchema } from '@formaai/shared';
import type { ServerContext } from '../server-context.js';
import { parseBody, parseParams, requireUser } from '../plugins/auth-helpers.js';

const credentialParams = z.object({ credentialId: z.string().uuid() });

export async function registerCredentialRoutes(instance: FastifyInstance, ctx: ServerContext): Promise<void> {
  const credentials = ctx.credentialService;

  instance.get('/api/provider-credentials', async (request, reply) => {
    const user = requireUser(request);
    return reply.send({
      credentials: await credentials.list(user),
      supportedTypes: ctx.providers.list(),
      devProviderEnabled: ctx.config.ENABLE_DEV_PROVIDER,
    });
  });

  instance.post(
    '/api/provider-credentials',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const input = parseBody(request, providerCredentialCreateSchema);
      const credential = await credentials.create(user, input);
      request.log.info({ userId: user.userId, credentialId: credential.id }, 'provider credential created');
      return reply.status(201).send({ credential });
    },
  );

  instance.patch('/api/provider-credentials/:credentialId', async (request, reply) => {
    const user = requireUser(request);
    const { credentialId } = parseParams(request, credentialParams);
    const input = parseBody(request, providerCredentialUpdateSchema);
    return reply.send({ credential: await credentials.update(user, credentialId, input) });
  });

  instance.delete('/api/provider-credentials/:credentialId', async (request, reply) => {
    const user = requireUser(request);
    const { credentialId } = parseParams(request, credentialParams);
    await credentials.remove(user, credentialId);
    return reply.send({ ok: true });
  });

  instance.post(
    '/api/provider-credentials/:credentialId/test',
    { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { credentialId } = parseParams(request, credentialParams);
      const result = await credentials.testConnection(user, credentialId);
      return reply.send({ result });
    },
  );

  instance.post('/api/provider-credentials/fallback', async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(request, providerFallbackSchema);
    await credentials.setFallback(user, input.fallbackCredentialId);
    return reply.send({ ok: true });
  });

  instance.get(
    '/api/provider-credentials/:credentialId/models',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const user = requireUser(request);
      const { credentialId } = parseParams(request, credentialParams);
      return reply.send(await credentials.listModels(user, credentialId));
    },
  );

  instance.get('/api/usage', async (request, reply) => {
    const user = requireUser(request);
    const [events, summary] = await Promise.all([ctx.usageService.list(user, 100), ctx.usageService.summary(user)]);
    return reply.send({ events, summary });
  });
}

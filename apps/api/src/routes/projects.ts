import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { projectCreateSchema, projectListQuerySchema, projectUpdateSchema } from '@formaai/shared';
import type { ServerContext } from '../server-context.js';
import { parseBody, parseParams, parseQuery, requireUser } from '../plugins/auth-helpers.js';

const idParams = z.object({ projectId: z.string().uuid() });

export async function registerProjectRoutes(instance: FastifyInstance, ctx: ServerContext): Promise<void> {
  const projects = ctx.projectService;

  instance.get('/api/projects', async (request, reply) => {
    const user = requireUser(request);
    const query = parseQuery(request, projectListQuerySchema);
    return reply.send({ projects: await projects.list(user, query) });
  });

  instance.post('/api/projects', async (request, reply) => {
    const user = requireUser(request);
    const input = parseBody(request, projectCreateSchema);
    const project = await projects.create(user, input);
    return reply.status(201).send({ project });
  });

  instance.get('/api/projects/:projectId', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, idParams);
    const project = await projects.getOwned(user, projectId);
    return reply.send({ project });
  });

  instance.patch('/api/projects/:projectId', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, idParams);
    const input = parseBody(request, projectUpdateSchema);
    const project = await projects.update(user, projectId, input);
    return reply.send({ project });
  });

  instance.post('/api/projects/:projectId/archive', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, idParams);
    return reply.send({ project: await projects.archive(user, projectId) });
  });

  instance.post('/api/projects/:projectId/restore', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, idParams);
    return reply.send({ project: await projects.restore(user, projectId) });
  });

  instance.delete('/api/projects/:projectId', async (request, reply) => {
    const user = requireUser(request);
    const { projectId } = parseParams(request, idParams);
    await projects.delete(user, projectId);
    return reply.send({ ok: true });
  });

  instance.get('/api/usage/documents', async (_request, reply) => {
    // Document quota is surfaced by the client from the user row via /api/account.
    return reply.send({ ok: true });
  });
}

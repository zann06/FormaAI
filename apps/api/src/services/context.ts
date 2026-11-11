import type { Database } from '../db/client.js';
import type { StorageAdapter } from './storage/index.js';
import type { AuthContext } from './auth/index.js';
import type { AppConfig } from '../config.js';

export interface AppContext {
  config: AppConfig;
  db: Database;
  storage: StorageAdapter;
}

export interface ServiceContext extends AppContext {
  /** Resolve the authenticated user for a request; throws Unauthorized. */
  auth: () => AuthContext;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthContext | null;
  }
  interface FastifyInstance {
    appContext: AppContext;
  }
}

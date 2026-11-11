import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db/client.js';
import type { AuthService } from './services/auth/index.js';
import type { ProjectService } from './services/projects/index.js';
import type { DocumentService } from './services/documents/index.js';
import type { TemplateService } from './services/template/index.js';
import type { CredentialService } from './services/credentials/index.js';
import type { FactService } from './services/facts/index.js';
import type { MappingService } from './services/mapping/index.js';
import type { GenerationService } from './services/generation/index.js';
import type { ExportService } from './services/export/index.js';
import type { UsageService } from './services/usage/index.js';
import type { ProviderRegistry } from '@formaai/ai-providers';
import type { ServerServices } from './server.js';

/**
 * Everything a route module needs. Routes never reach for globals: all
 * dependencies (DB, storage, providers, config) are injected once at boot so
 * tests can substitute them.
 */
export interface ServerContext {
  config: AppConfig;
  db: Database;
  auth: AuthService;
  services: ServerServices;
  projectService: ProjectService;
  documentService: DocumentService;
  templateService: TemplateService;
  credentialService: CredentialService;
  factService: FactService;
  mappingService: MappingService;
  generationService: GenerationService;
  exportService: ExportService;
  usageService: UsageService;
  providers: ProviderRegistry;
}

export type RouteRegistrar = (instance: FastifyInstance, ctx: ServerContext) => Promise<void>;

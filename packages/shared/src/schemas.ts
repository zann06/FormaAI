import { z } from 'zod';
import {
  INSERTION_STRATEGIES,
  JOB_KINDS,
  PROJECT_STATUSES,
  PROVIDER_TYPES,
  SECTION_STATUSES,
} from './constants.js';

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(200),
  confirm: z.literal('DELETE'),
});

export const projectCreateSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(160),
  reportType: z.string().trim().max(80).optional(),
  language: z.string().trim().min(2).max(10).default('en'),
  tone: z.string().trim().max(40).optional(),
  audience: z.string().trim().max(160).optional(),
  instructions: z.string().trim().max(8000).optional(),
  targetLength: z.enum(['short', 'medium', 'long']).optional(),
});

export const projectUpdateSchema = projectCreateSchema.partial().extend({
  status: z.enum(PROJECT_STATUSES).optional(),
});

export const projectListQuerySchema = z.object({
  includeArchived: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
  search: z.string().trim().max(120).optional(),
});

export const outlineSectionUpdateSchema = z.object({
  heading: z.string().trim().min(1).max(400).optional(),
  required: z.boolean().optional(),
  insertionStrategy: z.enum(INSERTION_STRATEGIES).optional(),
  placeholder: z.string().trim().max(120).nullable().optional(),
  order: z.number().int().min(0).optional(),
  excluded: z.boolean().optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
});

export const outlineReorderSchema = z.object({
  order: z.array(z.string().min(1)).min(1),
});

export const providerCredentialCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  providerType: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().trim().url('Base URL must be a valid URL').max(500).optional(),
  model: z.string().trim().min(1).max(160),
  apiKey: z.string().trim().min(1, 'API key is required').max(4000),
  sessionOnly: z.boolean().optional().default(false),
  isDefault: z.boolean().optional().default(false),
  requestSettings: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(64).max(200000).optional(),
      topP: z.number().min(0).max(1).optional(),
      // Zod 4 requires an explicit key schema; a record of header name → value
      // is a string-to-string map, so both sides are spelled out.
      extraHeaders: z.record(z.string(), z.string().max(200)).optional(),
      apiVersion: z.string().max(40).optional(),
    })
    .partial()
    .optional(),
});

export const providerCredentialUpdateSchema = providerCredentialCreateSchema
  .omit({ apiKey: true })
  .partial()
  .extend({
    apiKey: z.string().trim().min(1).max(4000).optional(),
    isDefault: z.boolean().optional(),
  });

export const providerFallbackSchema = z.object({
  fallbackCredentialId: z.string().uuid().nullable(),
});

export const sectionUpdateSchema = z.object({
  content: z.string().max(200000),
  status: z.enum(SECTION_STATUSES).optional(),
  baseVersion: z.number().int().min(0).optional(),
});

export const sectionRegenerateSchema = z.object({
  instructions: z.string().trim().max(2000).optional(),
  keepEdits: z.boolean().optional().default(false),
});

export const generateAllSchema = z.object({
  sectionIds: z.array(z.string().uuid()).max(200).optional(),
  providerCredentialId: z.string().uuid().optional(),
  regenerateExisting: z.boolean().optional().default(false),
});

export const exportRequestSchema = z.object({
  format: z.enum(['docx', 'pdf']),
});

export const jobListQuerySchema = z.object({
  kind: z.enum(JOB_KINDS).optional(),
  status: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ProviderCredentialCreateInput = z.infer<typeof providerCredentialCreateSchema>;
export type ProviderCredentialUpdateInput = z.infer<typeof providerCredentialUpdateSchema>;
export type SectionUpdateInput = z.infer<typeof sectionUpdateSchema>;
export type OutlineSectionUpdateInput = z.infer<typeof outlineSectionUpdateSchema>;
export type OutlineReorderInput = z.infer<typeof outlineReorderSchema>;
export type SectionRegenerateInput = z.infer<typeof sectionRegenerateSchema>;
export type GenerateAllInput = z.infer<typeof generateAllSchema>;
export type ExportRequestInput = z.infer<typeof exportRequestSchema>;

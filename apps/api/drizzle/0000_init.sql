CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"credential_id" uuid,
	"job_id" uuid,
	"provider_type" varchar(40) NOT NULL,
	"model" varchar(160) NOT NULL,
	"operation" varchar(40) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"status" varchar(20) NOT NULL,
	"error_code" varchar(40),
	"fallback_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" varchar(60) NOT NULL,
	"entity_type" varchar(40),
	"entity_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"original_name" varchar(300) NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(160) NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'uploaded' NOT NULL,
	"page_count" integer,
	"word_count" integer,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"extraction_method" varchar(40),
	"extraction_error" text,
	"extracted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid,
	"format" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"size_bytes" integer,
	"checksum" varchar(64),
	"version_number" integer DEFAULT 1 NOT NULL,
	"fidelity_report" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extracted_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"page" integer,
	"paragraph_index" integer,
	"sheet" varchar(120),
	"slide" integer,
	"start_offset" integer,
	"end_offset" integer,
	"heading_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid,
	"kind" varchar(40) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"stage" varchar(60),
	"progress" integer DEFAULT 0 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"stage_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error_code" varchar(60),
	"error_message" text,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"report_type" varchar(80),
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"tone" varchar(40),
	"audience" varchar(160),
	"instructions" text,
	"target_length" varchar(20),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"template_ready" boolean DEFAULT false NOT NULL,
	"mapping_ready" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" varchar(80) NOT NULL,
	"provider_type" varchar(40) NOT NULL,
	"base_url" varchar(500),
	"model" varchar(160) NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_iv" varchar(64) NOT NULL,
	"api_key_tag" varchar(64) NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"key_last4" varchar(4) NOT NULL,
	"key_fingerprint" varchar(32) NOT NULL,
	"session_only" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_test_status" varchar(20),
	"last_test_message" text,
	"last_tested_at" timestamp with time zone,
	"request_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"template_section_id" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"status" varchar(20) DEFAULT 'empty' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"cited_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"placeholders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_credential_id" uuid,
	"model_used" varchar(160),
	"generated_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"word_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"label" varchar(160) NOT NULL,
	"kind" varchar(30) DEFAULT 'snapshot' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" varchar(30) DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "section_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"purpose" text,
	"requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage" varchar(20) DEFAULT 'none' NOT NULL,
	"produced_by" varchar(20) DEFAULT 'heuristic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"user_agent" varchar(300),
	"ip_hash" varchar(64),
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"text" text NOT NULL,
	"category" varchar(30) NOT NULL,
	"subject" varchar(200),
	"value" varchar(300),
	"normalized_value" varchar(300),
	"page" integer,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"produced_by" varchar(20) DEFAULT 'heuristic' NOT NULL,
	"review_status" varchar(20) DEFAULT 'unreviewed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"section_key" varchar(120) NOT NULL,
	"heading_original" text NOT NULL,
	"heading" text NOT NULL,
	"level" integer NOT NULL,
	"sort_order" integer NOT NULL,
	"paragraph_index" integer NOT NULL,
	"style_id" varchar(120),
	"body_preview" text,
	"table_count" integer DEFAULT 0 NOT NULL,
	"has_images" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"insertion_strategy" varchar(20) DEFAULT 'after_heading' NOT NULL,
	"placeholder" varchar(120),
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(80),
	"role" varchar(20) DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"fallback_credential_id" uuid,
	"storage_used_bytes" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_version_id_report_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."report_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_chunks" ADD CONSTRAINT "extracted_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_chunks" ADD CONSTRAINT "extracted_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_chunks" ADD CONSTRAINT "extracted_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sections" ADD CONSTRAINT "report_sections_template_section_id_template_sections_id_fk" FOREIGN KEY ("template_section_id") REFERENCES "public"."template_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_mappings" ADD CONSTRAINT "section_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_mappings" ADD CONSTRAINT "section_mappings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_mappings" ADD CONSTRAINT "section_mappings_section_id_template_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."template_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_facts" ADD CONSTRAINT "source_facts_chunk_id_extracted_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."extracted_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_sections" ADD CONSTRAINT "template_sections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_sections" ADD CONSTRAINT "template_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_sections" ADD CONSTRAINT "template_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_user_created_idx" ON "ai_usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_user_created_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_project_idx" ON "documents" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "documents_user_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_project_template_unique" ON "documents" USING btree ("project_id") WHERE kind = 'template';--> statement-breakpoint
CREATE INDEX "exports_project_idx" ON "export_artifacts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "extracted_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "chunks_project_idx" ON "extracted_chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "processing_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_project_idx" ON "processing_jobs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "processing_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "projects_user_updated_idx" ON "projects" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "credentials_user_idx" ON "provider_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_sections_template_unique" ON "report_sections" USING btree ("template_section_id");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_project_number_unique" ON "report_versions" USING btree ("project_id","version_number");--> statement-breakpoint
CREATE INDEX "versions_project_idx" ON "report_versions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mappings_section_unique" ON "section_mappings" USING btree ("section_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "facts_project_idx" ON "source_facts" USING btree ("project_id","category");--> statement-breakpoint
CREATE INDEX "facts_chunk_idx" ON "source_facts" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "sections_project_idx" ON "template_sections" USING btree ("project_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "sections_project_key_unique" ON "template_sections" USING btree ("project_id","section_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));
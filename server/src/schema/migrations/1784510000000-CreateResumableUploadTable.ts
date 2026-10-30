import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "resumable_upload" (
    "id" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "filename" character varying NOT NULL,
    "fileSize" bigint NOT NULL,
    "checksum" bytea NOT NULL,
    "offset" bigint NOT NULL DEFAULT 0,
    "tempPath" character varying NOT NULL,
    "metadata" jsonb NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    "expiresAt" timestamp with time zone NOT NULL,
    CONSTRAINT "resumable_upload_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "resumable_upload_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON DELETE CASCADE
  );`.execute(db);
  await sql`CREATE INDEX "resumable_upload_ownerId_idx" ON "resumable_upload" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "resumable_upload_expiresAt_idx" ON "resumable_upload" ("expiresAt");`.execute(db);
  await sql`CREATE TRIGGER "resumable_upload_updatedAt" BEFORE UPDATE ON "resumable_upload"
    FOR EACH ROW EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_resumable_upload_updatedAt', '{"type":"trigger","name":"resumable_upload_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"resumable_upload_updatedAt\\"\\n  BEFORE UPDATE ON \\"resumable_upload\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_resumable_upload_updatedAt';`.execute(db);
  await sql`DROP TABLE "resumable_upload";`.execute(db);
}

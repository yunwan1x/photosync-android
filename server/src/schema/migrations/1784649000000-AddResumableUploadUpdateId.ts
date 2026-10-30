import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "resumable_upload" ADD COLUMN IF NOT EXISTS "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "resumable_upload" DROP COLUMN IF EXISTS "updateId";`.execute(db);
}

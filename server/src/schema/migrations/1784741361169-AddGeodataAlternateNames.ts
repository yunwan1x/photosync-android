import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "geodata_places" ADD COLUMN "admin1Id" integer;`.execute(db);
  await sql`ALTER TABLE "geodata_places" ADD COLUMN "admin2Id" integer;`.execute(db);
  await sql`CREATE TABLE "geodata_alternate_names" (
    "id" integer NOT NULL,
    "geonameId" integer NOT NULL,
    "isolanguage" character varying(7),
    "name" character varying(400) NOT NULL,
    "isPreferredName" boolean NOT NULL DEFAULT false,
    "isShortName" boolean NOT NULL DEFAULT false,
    "isColloquial" boolean NOT NULL DEFAULT false,
    "isHistoric" boolean NOT NULL DEFAULT false,
    "validFrom" character varying,
    "validTo" character varying,
    CONSTRAINT "geodata_alternate_names_pkey" PRIMARY KEY ("id")
  );`.execute(db);
  await sql`CREATE INDEX "idx_geodata_alternate_names_lookup" ON "geodata_alternate_names" ("geonameId", "isolanguage", "isPreferredName");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "geodata_alternate_names";`.execute(db);
  await sql`ALTER TABLE "geodata_places" DROP COLUMN "admin2Id";`.execute(db);
  await sql`ALTER TABLE "geodata_places" DROP COLUMN "admin1Id";`.execute(db);
}

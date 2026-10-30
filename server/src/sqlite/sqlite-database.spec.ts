import { schemaDiff, schemaFromCode } from '@immich/sql-tools';
import Database from 'better-sqlite3';
import { Kysely, sql } from 'kysely';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType, ChecksumAlgorithm } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { ResumableUploadRepository } from 'src/repositories/resumable-upload.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { ViewRepository } from 'src/repositories/view-repository';
import { DB } from 'src/schema';
import { immich_uuid_v7 } from 'src/schema/functions';
import { createSqliteDatabase } from 'src/sqlite/sqlite-database';
import {
  getCurrentDatabaseTables,
  initializeSqliteSchema,
  schemaFromSqlite,
  SQLITE_BASELINE_VERSION,
} from 'src/sqlite/sqlite-schema';
import { getKyselyConfig } from 'src/utils/database';
import { jsonColumn } from 'src/utils/database-helpers';
import { factory } from 'test/small.factory';

describe('SQLite backend', () => {
  let folder: string;
  let filePath: string;
  let database: Database.Database;
  const previousBackend = process.env.DB_BACKEND;

  beforeAll(async () => {
    process.env.DB_BACKEND = 'sqlite';
    folder = await mkdtemp(join(tmpdir(), 'immich-sqlite-'));
    filePath = join(folder, 'immich.sqlite');
    const kysely = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: filePath }));
    await initializeSqliteSchema(kysely);
    await kysely.destroy();
    database = createSqliteDatabase(filePath);
  });

  afterAll(async () => {
    database.close();
    await rm(folder, { recursive: true, force: true });
    process.env.DB_BACKEND = previousBackend;
  });

  it('creates the full current schema with WAL and valid foreign keys', () => {
    expect(getCurrentDatabaseTables().length).toBeGreaterThan(60);
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    const audioVideoTables = database
      .prepare(
        "select name from sqlite_master where type = 'table' and name in ('asset_audio', 'asset_video', 'asset_keyframe')",
      )
      .pluck()
      .all();
    expect(audioVideoTables).toHaveLength(3);
    expect(database.prepare("select value from immich_sqlite_meta where key = 'baseline_version'").pluck().get()).toBe(
      SQLITE_BASELINE_VERSION.toString(),
    );
  });

  it('keeps matching tables and indexes in place on repeated initialization', async () => {
    const before = database
      .prepare(
        "SELECT type, name, rootpage FROM sqlite_master WHERE name IN ('album', 'asset_localDateTime_idx') ORDER BY name",
      )
      .all();
    const db = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: filePath }));
    await initializeSqliteSchema(db);
    await db.destroy();
    const after = database
      .prepare(
        "SELECT type, name, rootpage FROM sqlite_master WHERE name IN ('album', 'asset_localDateTime_idx') ORDER BY name",
      )
      .all();
    expect(after).toEqual(before);
  });

  it('detects and repairs a missing regular column without losing existing rows', async () => {
    const legacyPath = join(folder, 'legacy-column.sqlite');
    const kysely = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: legacyPath }));
    await initializeSqliteSchema(kysely);
    await kysely.insertInto('album').values({ albumName: 'Existing album', description: 'old' }).execute();
    const owner = await kysely
      .insertInto('user')
      .values({ email: 'resumable-upgrade@example.com', name: 'Resumable Upgrade' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const uploadId = '00000000-0000-4000-8000-000000000010';
    await kysely
      .insertInto('resumable_upload')
      .values({
        id: uploadId,
        ownerId: owner.id,
        filename: 'upgrade.jpg',
        fileSize: 1,
        checksum: Buffer.from('upgrade-checksum'),
        offset: 0,
        tempPath: '/tmp/upgrade.jpg.part',
        metadata: { source: 'upgrade-test' },
        expiresAt: new Date('2026-07-22T00:00:00.000Z'),
      })
      .execute();
    await sql`ALTER TABLE album DROP COLUMN description`.execute(kysely);
    await sql`DROP TRIGGER resumable_upload_updatedAt`.execute(kysely);
    await sql`ALTER TABLE resumable_upload DROP COLUMN updateId`.execute(kysely);

    const source = schemaFromCode({
      overrides: true,
      namingStrategy: 'default',
      uuidFunction: (version) => (version === 7 ? `${immich_uuid_v7.name}()` : 'uuid_generate_v4()'),
    });
    const target = await schemaFromSqlite(kysely, source);
    expect(
      schemaDiff(source, target, { tables: { ignoreExtra: true }, columns: { ignoreExtra: true } }).asHuman(),
    ).toEqual(expect.arrayContaining([expect.stringContaining('table "album" is missing')]));

    await initializeSqliteSchema(kysely);
    const album = await kysely.selectFrom('album').select(['albumName', 'description']).executeTakeFirstOrThrow();
    expect(album).toEqual({ albumName: 'Existing album', description: '' });
    const appended = await new ResumableUploadRepository(kysely).append(uploadId, owner.id, 0, () =>
      Promise.resolve(1),
    );
    expect(appended).toEqual(
      expect.objectContaining({
        offsetMismatch: false,
        session: expect.objectContaining({ offset: 1, updateId: expect.any(String) }),
      }),
    );

    await sql`DROP INDEX asset_localDateTime_idx`.execute(kysely);
    await sql`DROP INDEX asset_localDateTime_month_idx`.execute(kysely);
    await sql`ALTER TABLE asset DROP COLUMN localDateTime`.execute(kysely);
    await initializeSqliteSchema(kysely);
    const repairedColumns = await sql<{ name: string }>`PRAGMA table_info(asset)`.execute(kysely);
    expect(repairedColumns.rows.map(({ name }) => name)).toContain('localDateTime');
    const repairedIndexes = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('asset_localDateTime_idx', 'asset_localDateTime_month_idx')`.execute(
      kysely,
    );
    expect(repairedIndexes.rows).toHaveLength(2);
    await kysely.destroy();
  });

  it('repairs changed constraints, indexes, and triggers without losing rows', async () => {
    const legacyPath = join(folder, 'legacy-derived-schema.sqlite');
    const kysely = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: legacyPath }));
    await initializeSqliteSchema(kysely);
    await kysely.insertInto('user_audit').values({ userId: '00000000-0000-4000-8000-000000000001' }).execute();
    const user = await kysely
      .insertInto('user')
      .values({ email: 'schema-repair@example.com', name: 'Schema Repair' })
      .returning(['id', 'updateId'])
      .executeTakeFirstOrThrow();
    await kysely.destroy();

    const legacy = createSqliteDatabase(legacyPath);
    const userAuditSql = legacy
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_audit'")
      .pluck()
      .get() as string;
    const staleUserAuditSql = userAuditSql.replace('"userId" TEXT NOT NULL', '"userId" TEXT');
    legacy.exec(`
      ALTER TABLE "user_audit" RENAME TO "user_audit_old";
      ${staleUserAuditSql};
      INSERT INTO "user_audit" SELECT * FROM "user_audit_old";
      DROP TABLE "user_audit_old";
      CREATE INDEX "user_audit_deletedAt_idx" ON "user_audit" ("userId");
      DROP TRIGGER "user_updatedAt";
      CREATE TRIGGER "user_updatedAt" AFTER UPDATE ON "user" BEGIN SELECT 1; END;
      CREATE TRIGGER "obsolete_managed_trigger" AFTER UPDATE ON "user" BEGIN SELECT 1; END;
    `);
    legacy
      .prepare("UPDATE immich_sqlite_meta SET value = ? WHERE key = 'managed_derived_objects'")
      .run(JSON.stringify([{ type: 'trigger', name: 'obsolete_managed_trigger' }]));
    legacy.close();

    const repaired = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: legacyPath }));
    await initializeSqliteSchema(repaired);
    const auditRow = await repaired.selectFrom('user_audit').select('userId').executeTakeFirstOrThrow();
    expect(auditRow.userId).toBe('00000000-0000-4000-8000-000000000001');
    await repaired.updateTable('user').set({ name: 'Repaired' }).where('id', '=', user.id).execute();
    const updatedUser = await repaired
      .selectFrom('user')
      .select('updateId')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(updatedUser.updateId).not.toBe(user.updateId);
    await repaired.destroy();

    const inspected = createSqliteDatabase(legacyPath);
    try {
      const columns = inspected.pragma('table_info("user_audit")') as Array<{ name: string; notnull: number }>;
      expect(columns.find(({ name }) => name === 'userId')?.notnull).toBe(1);
      expect(
        inspected
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'user_audit_deletedAt_idx'")
          .pluck()
          .get(),
      ).toContain('"deletedAt"');
      expect(
        inspected
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'user_updatedAt'")
          .pluck()
          .get(),
      ).toContain('"updateId"');
      expect(
        inspected
          .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'obsolete_managed_trigger'")
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      inspected.close();
    }
  });

  it('rebuilds referenced parent tables without cascading child rows', async () => {
    const legacyPath = join(folder, 'legacy-parent-schema.sqlite');
    const db = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: legacyPath }));
    await initializeSqliteSchema(db);
    const user = await db
      .insertInto('user')
      .values({ email: 'parent-rebuild@example.com', name: 'Parent Rebuild' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('session')
      .values({
        token: Buffer.from('parent-rebuild-session'),
        userId: user.id,
        expiresAt: null,
        parentId: null,
        appVersion: null,
        pinExpiresAt: null,
        oauthSid: null,
      })
      .execute();
    await sql.raw('ALTER TABLE "user" ADD COLUMN "legacyColumn" TEXT').execute(db);

    await initializeSqliteSchema(db);

    expect(await db.selectFrom('user').select('id').where('id', '=', user.id).executeTakeFirst()).toBeDefined();
    expect(await db.selectFrom('session').select('id').where('userId', '=', user.id).execute()).toHaveLength(1);
    const foreignKeyCheck = await sql`PRAGMA foreign_key_check`.execute(db);
    const foreignKeys = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
    expect(foreignKeyCheck.rows).toEqual([]);
    expect(foreignKeys.rows[0]?.foreign_keys).toBe(1);
    await db.destroy();
  });

  it('keeps JSON-looking and ISO-date-looking text as text while hydrating JSON projections', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: filePath }));
    const jsonValue = { when: '2026-07-19T08:05:00.000Z', enabled: 1, nested: ['json'] };
    const album = await db
      .insertInto('album')
      .values({ albumName: '2026-07-22T12:34:56.000Z', description: '{"note":"plain text"}' })
      .returning(['id', 'albumName', 'description'])
      .executeTakeFirstOrThrow();
    try {
      expect(album.albumName).toBe('2026-07-22T12:34:56.000Z');
      expect(album.description).toBe('{"note":"plain text"}');
      const result = await db.selectNoFrom((eb) => jsonColumn(eb.val(jsonValue)).as('value')).executeTakeFirstOrThrow();
      expect(result.value).toEqual(jsonValue);
    } finally {
      await db.deleteFrom('album').where('id', '=', album.id).execute();
      await db.destroy();
    }
  });

  it.each(['"', 'hello OR', 'say "hello"'])('does not treat OCR text %j as FTS5 syntax', async (ocr) => {
    const db = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: filePath }));
    try {
      const repository = new SearchRepository(db);
      await expect(repository.searchMetadata({ page: 1, size: 10 }, { ocr })).resolves.toEqual(
        expect.objectContaining({ items: expect.any(Array) }),
      );
    } finally {
      await db.destroy();
    }
  });

  it('creates vector embedding columns used by smart search and face search', () => {
    for (const table of ['smart_search', 'face_search']) {
      const columns = database.pragma(`table_info("${table}")`) as Array<{ name: string; type: string }>;
      expect(columns).toContainEqual(expect.objectContaining({ name: 'embedding', type: 'BLOB' }));
      expect(() => database.prepare(`select vec_length(embedding) from "${table}" limit 1`).all()).not.toThrow();
    }
  });

  it('persists a non-default CLIP dimension while the embedding table is empty', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: filePath }));
    const repository = new DatabaseRepository(
      db,
      { setContext: vi.fn() } as never,
      { getEnv: () => ({ database: { config: { backend: 'sqlite', path: filePath } } }) } as never,
    );
    try {
      await repository.setDimensionSize(768);
      expect(await repository.getDimensionSize('smart_search')).toBe(768);
    } finally {
      await repository.setDimensionSize(512);
      await db.destroy();
    }
  });

  it('repairs vector columns omitted by an older SQLite baseline', async () => {
    const legacyPath = join(folder, 'legacy.sqlite');
    const legacy = createSqliteDatabase(legacyPath);
    legacy.exec(`
      CREATE TABLE smart_search (assetId TEXT PRIMARY KEY);
      CREATE TABLE face_search (faceId TEXT PRIMARY KEY);
      INSERT INTO smart_search (assetId) VALUES ('incomplete-smart-search-row');
      INSERT INTO face_search (faceId) VALUES ('incomplete-face-search-row');
    `);
    legacy.close();

    const kysely = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: legacyPath }));
    await initializeSqliteSchema(kysely);
    await kysely.destroy();

    const repaired = createSqliteDatabase(legacyPath);
    try {
      for (const table of ['smart_search', 'face_search']) {
        const columns = repaired.pragma(`table_info("${table}")`) as Array<{ name: string; type: string }>;
        expect(columns).toContainEqual(expect.objectContaining({ name: 'embedding', type: 'BLOB' }));
        expect(repaired.prepare(`select count(*) from "${table}"`).pluck().get()).toBe(0);
      }
    } finally {
      repaired.close();
    }
  });

  it('uses UUID v4 for API entity IDs and UUID v7 for update cursors', () => {
    const row = database.prepare('select immich_uuid_v4() as id, immich_uuid_v7() as updateId').get() as {
      id: string;
      updateId: string;
    };
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(row.updateId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('matches PostgreSQL unaccent null semantics', () => {
    expect(database.prepare('select f_unaccent(NULL)').pluck().get()).toBeNull();
    expect(database.prepare("select f_unaccent('Crème brûlée')").pluck().get()).toBe('Creme brulee');
    expect(database.prepare("select f_unaccent('Łódź Æsir')").pluck().get()).toBe('Lodz AEsir');
  });

  it('matches PostgreSQL LIKE and regexp replacement semantics', () => {
    expect(database.prepare("select 'A/B.JPG' like 'a/%' as matched").pluck().get()).toBe(0);
    expect(database.prepare("select immich_lower('ÄBC') like immich_lower('äbc') as matched").pluck().get()).toBe(1);
    expect(
      database
        .prepare("select regexp_replace('/a/z.jpg', '.*/(.+)', ?) as value")
        .pluck()
        .get(String.raw`\1`),
    ).toBe('z.jpg');
    expect(database.prepare("select regexp_replace('abcabc', 'a', 'x') as value").pluck().get()).toBe('xbcabc');
    expect(database.prepare("select regexp_replace('abc', 'b', '$&') as value").pluck().get()).toBe('a$&c');
  });

  it('enforces PostgreSQL enum values', () => {
    const definition = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'asset'")
      .pluck()
      .get() as string;
    expect(definition).toContain('CHECK ("checksumAlgorithm" IN');
    expect(() =>
      database
        .prepare(
          `insert into asset (ownerId, type, originalPath, fileCreatedAt, fileModifiedAt, checksum,
            checksumAlgorithm, originalFileName, localDateTime)
           values (?, 'IMAGE', '/tmp/invalid-enum.jpg', ?, ?, ?, 'invalid', 'invalid-enum.jpg', ?)`,
        )
        .run(
          '00000000-0000-4000-8000-000000000000',
          new Date().toISOString(),
          new Date().toISOString(),
          Buffer.from('invalid-enum'),
          new Date().toISOString(),
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('extracts unique directories and sorts their direct assets by filename', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: filePath }));
    const user = await db
      .insertInto('user')
      .values({ email: 'folder-view@example.com', name: 'Folder View' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const date = new Date('2026-07-22T08:00:00.000Z');
    const assets = await db
      .insertInto('asset')
      .values(
        ['z.jpg', 'a.jpg'].map((filename) => ({
          ownerId: user.id,
          type: AssetType.Image,
          originalPath: `/photos/Camera/${filename}`,
          fileCreatedAt: date,
          fileModifiedAt: date,
          checksum: Buffer.from(`folder-${filename}`),
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalFileName: filename,
          localDateTime: date,
        })),
      )
      .returning('id')
      .execute();
    try {
      for (const { id } of assets) {
        await db.insertInto('asset_exif').values({ assetId: id }).execute();
      }
      const repository = new ViewRepository(db);
      await expect(repository.getUniqueOriginalPaths(user.id)).resolves.toEqual(['/photos/Camera']);
      await expect(repository.getAssetsByOriginalPath(user.id, '/photos/Camera')).resolves.toEqual([
        expect.objectContaining({ originalFileName: 'a.jpg' }),
        expect.objectContaining({ originalFileName: 'z.jpg' }),
      ]);
    } finally {
      await db.deleteFrom('user').where('id', '=', user.id).execute();
      await db.destroy();
    }
  });

  it('keeps update triggers and OCR FTS synchronized', () => {
    database.prepare('insert into user (email, name) values (?, ?)').run('sqlite@example.com', 'Before');
    const user = database.prepare('select id, updateId from user').get() as { id: string; updateId: string };
    database.prepare('update user set name = ? where id = ?').run('After', user.id);
    const updated = database.prepare('select updateId from user where id = ?').get(user.id) as { updateId: string };
    expect(updated.updateId).not.toBe(user.updateId);

    database
      .prepare(
        `insert into asset (ownerId, type, originalPath, fileCreatedAt, fileModifiedAt, checksum,
          checksumAlgorithm, originalFileName, localDateTime)
         values (?, 'IMAGE', '/tmp/test.jpg', ?, ?, ?, 'sha1', 'test.jpg', ?)`,
      )
      .run(
        user.id,
        new Date().toISOString(),
        new Date().toISOString(),
        Buffer.from('checksum'),
        new Date().toISOString(),
      );
    const assetId = database.prepare('select id from asset').pluck().get() as string;
    database.prepare('insert into ocr_search (assetId, text) values (?, ?)').run(assetId, 'receipt number 12345');
    expect(
      database.prepare("select count(*) from ocr_search_fts where ocr_search_fts match 'receipt'").pluck().get(),
    ).toBe(1);
    database.prepare('update ocr_search set text = ? where assetId = ?').run('invoice number 54321', assetId);
    expect(
      database.prepare("select count(*) from ocr_search_fts where ocr_search_fts match 'receipt'").pluck().get(),
    ).toBe(0);
  });

  it('supports vector distance and geographic functions', () => {
    const distance = database
      .prepare("select vec_distance_cosine(vec_f32('[1,0,0]'), vec_f32('[0,1,0]'))")
      .pluck()
      .get() as number;
    expect(distance).toBeCloseTo(1);
    const meters = database.prepare('select haversine_distance(0, 0, 0, 1)').pluck().get() as number;
    expect(meters).toBeGreaterThan(111_000);
    expect(database.prepare("select point_in_polygon('((0,0), (2,0), (2,2), (0,2), (0,0))', 1, 1)").pluck().get()).toBe(
      1,
    );
  });

  it('loads photo and album time buckets using the ISO month sent by the web timeline', async () => {
    const db = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: filePath }));
    let userId: string | undefined;
    let assetId: string | undefined;
    let albumId: string | undefined;
    try {
      const user = await db
        .insertInto('user')
        .values({ email: 'timeline@example.com', name: 'Timeline' })
        .returning('id')
        .executeTakeFirstOrThrow();
      userId = user.id;
      const asset = await db
        .insertInto('asset')
        .values({
          ownerId: user.id,
          type: AssetType.Image,
          originalPath: '/tmp/timeline.jpg',
          fileCreatedAt: new Date('2026-07-19T08:30:00.000Z'),
          fileModifiedAt: new Date('2026-07-19T08:30:00.000Z'),
          checksum: Buffer.from('timeline-checksum'),
          checksumAlgorithm: ChecksumAlgorithm.sha1File,
          originalFileName: 'timeline.jpg',
          localDateTime: new Date('2026-07-19T16:30:00.000Z'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      assetId = asset.id;
      await db.insertInto('asset_exif').values({ assetId: asset.id }).execute();
      const album = await db
        .insertInto('album')
        .values({ albumName: 'WeiXin' })
        .returning('id')
        .executeTakeFirstOrThrow();
      albumId = album.id;
      await db.insertInto('album_asset').values({ albumId: album.id, assetId: asset.id }).execute();

      const repository = new AssetRepository(db);
      await expect(repository.getTimeBuckets({ userIds: [user.id] })).resolves.toEqual([
        { count: 1, timeBucket: '2026-07-01' },
      ]);
      await expect(repository.getTimeBuckets({ userIds: [user.id], withStacked: true })).resolves.toEqual([
        { count: 1, timeBucket: '2026-07-01' },
      ]);

      const auth = factory.auth({ user: { id: user.id } });
      const photoBucket = await repository.getTimeBucket('2026-07-01T00:00:00.000Z', { userIds: [user.id] }, auth);
      expect(JSON.parse(photoBucket.assets).id).toEqual([asset.id]);

      const albumBucket = await repository.getTimeBucket(
        '2026-07-01T00:00:00.000Z',
        { albumId: album.id, userIds: [user.id] },
        auth,
      );
      expect(JSON.parse(albumBucket.assets).id).toEqual([asset.id]);
    } finally {
      if (albumId && assetId) {
        await db.deleteFrom('album_asset').where('albumId', '=', albumId).where('assetId', '=', assetId).execute();
      }
      if (albumId) {
        await db.deleteFrom('album').where('id', '=', albumId).execute();
      }
      if (assetId) {
        await db.deleteFrom('asset_exif').where('assetId', '=', assetId).execute();
        await db.deleteFrom('asset').where('id', '=', assetId).execute();
      }
      if (userId) {
        await db.deleteFrom('user').where('id', '=', userId).execute();
      }
      await db.destroy();
    }
  });

  it('creates a consistent online backup', async () => {
    const backupPath = join(folder, 'backup.sqlite');
    await database.backup(backupPath);
    const backup = createSqliteDatabase(backupPath);
    expect(backup.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(backup.prepare('select count(*) from user').pluck().get()).toBe(1);
    backup.close();
  });
});

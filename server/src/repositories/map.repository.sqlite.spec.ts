import { Kysely, sql } from 'kysely';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MapRepository } from 'src/repositories/map.repository';
import { DB } from 'src/schema';
import { initializeSqliteSchema } from 'src/sqlite/sqlite-schema';
import { getKyselyConfig } from 'src/utils/database';

describe('MapRepository SQLite GeoNames import', () => {
  let folder: string;
  let database: Kysely<DB>;
  let metadata: Record<string, unknown>;
  let geodataDateFile: string;
  let alternateNamesDateFile: string;
  let alternateNamesFile: string;
  let repository: MapRepository;
  const previousBackend = process.env.DB_BACKEND;

  beforeEach(async () => {
    process.env.DB_BACKEND = 'sqlite';
    folder = await mkdtemp(join(tmpdir(), 'immich-geonames-'));
    database = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: join(folder, 'immich.sqlite') }));
    await initializeSqliteSchema(database);

    geodataDateFile = join(folder, 'geodata-date.txt');
    alternateNamesDateFile = join(folder, 'alternateNamesV2-date.txt');
    alternateNamesFile = join(folder, 'alternateNamesV2.txt');
    await writeFile(geodataDateFile, 'cities-v1');
    await writeFile(alternateNamesDateFile, 'names-v1');
    await writeFile(
      alternateNamesFile,
      ['1\t1816670\tzh-CN\t北京\t1\t0\t0\t0\t\t', '1\t1816670\ten\tduplicate-id', '2\t1816670\ten\tBeijing'].join('\n'),
    );

    metadata = {
      lastUpdate: 'cities-v1',
      lastAlternateNamesUpdate: 'names-v0',
      lastImportFileName: 'cities500.txt',
      importVersion: 2,
    };
    const metadataRepository = {
      get: vi.fn(() => Promise.resolve(metadata)),
      set: vi.fn((_key, value) => {
        metadata = value;
        return Promise.resolve();
      }),
    };
    const configRepository = {
      getEnv: () => ({
        reverseGeocoding: { language: 'zh-CN' },
        resourcePaths: {
          geodata: {
            dateFile: geodataDateFile,
            alternateNamesDateFile,
            alternateNames: alternateNamesFile,
          },
        },
      }),
    };
    const logger = {
      setContext: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      debug: vi.fn(),
      verboseFn: vi.fn(),
    };
    repository = new MapRepository(
      configRepository as never,
      metadataRepository as never,
      logger as never,
      database as never,
    );
  });

  afterEach(async () => {
    await database.destroy();
    await rm(folder, { recursive: true, force: true });
    process.env.DB_BACKEND = previousBackend;
  });

  it('imports idempotently, ignores duplicate ids, and refreshes only when the data version changes', async () => {
    await repository.init();
    expect(await database.selectFrom('geodata_alternate_names').selectAll().orderBy('id').execute()).toMatchObject([
      { id: 1, name: '北京', isolanguage: 'zh-CN' },
      { id: 2, name: 'Beijing', isolanguage: 'en' },
    ]);
    expect(metadata).toMatchObject({ lastUpdate: 'cities-v1', lastAlternateNamesUpdate: 'names-v1', importVersion: 2 });

    await database.updateTable('geodata_alternate_names').set({ name: 'sentinel' }).where('id', '=', 1).execute();
    await repository.init();
    expect(
      await database.selectFrom('geodata_alternate_names').select('name').where('id', '=', 1).executeTakeFirstOrThrow(),
    ).toEqual({ name: 'sentinel' });

    await writeFile(alternateNamesDateFile, 'names-v2');
    await repository.init();
    expect(
      await database.selectFrom('geodata_alternate_names').select('name').where('id', '=', 1).executeTakeFirstOrThrow(),
    ).toEqual({ name: '北京' });
    expect(metadata).toMatchObject({ lastAlternateNamesUpdate: 'names-v2' });
  });

  it('rolls back the complete replacement if a later batch is interrupted', async () => {
    await database
      .insertInto('geodata_alternate_names')
      .values({
        id: 99,
        geonameId: 99,
        isolanguage: 'en',
        name: 'existing',
        isPreferredName: false,
        isShortName: false,
        isColloquial: false,
        isHistoric: false,
      })
      .execute();
    await sql`CREATE TRIGGER abort_geonames_import BEFORE INSERT ON geodata_alternate_names
      WHEN NEW.id = 1001 BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END`.execute(database);
    await writeFile(
      alternateNamesFile,
      Array.from({ length: 1001 }, (_, index) => `${index + 1}\t1816670\tzh-CN\t名称${index + 1}`).join('\n'),
    );

    await expect(repository.init()).rejects.toThrow('simulated interruption');
    expect(await database.selectFrom('geodata_alternate_names').select(['id', 'name']).execute()).toEqual([
      { id: 99, name: 'existing' },
    ]);
    expect(metadata).toMatchObject({ lastAlternateNamesUpdate: 'names-v0' });
  });

  it('uses the lookup index for localized-name queries', async () => {
    const result = await sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT name FROM geodata_alternate_names
      WHERE geonameId = 1816670 AND isolanguage = 'zh-CN' AND isPreferredName = 1`.execute(database);

    expect(result.rows.some(({ detail }) => detail.includes('idx_geodata_alternate_names_lookup'))).toBe(true);
  });
});

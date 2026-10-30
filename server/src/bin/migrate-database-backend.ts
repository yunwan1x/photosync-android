import { ConstraintType, DatabaseColumn, DatabaseTable } from '@immich/sql-tools';
import Database from 'better-sqlite3';
import { FileMigrationProvider, Kysely, Migrator } from 'kysely';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import postgres, { Sql } from 'postgres';
import { VectorIndex } from 'src/enum';
import { getVectorExtension } from 'src/repositories/database.repository';
import { DB } from 'src/schema';
import { createSqliteDatabase } from 'src/sqlite/sqlite-database';
import { getCurrentDatabaseTables, initializeSqliteSchema } from 'src/sqlite/sqlite-schema';
import { getKyselyConfig, vectorIndexQuery } from 'src/utils/database';
import { getDatabaseRowsDigest, getTransferableColumns } from 'src/utils/database-migration';

type Backend = 'postgres' | 'sqlite';
type Options = { from: Backend; to: Backend; postgresUrl: string; sqlitePath: string };

const backendOwnedTables = new Set(['migration_overrides']);
const DEFAULT_VECTOR_DIMENSION = 512;

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

const parseOptions = (): Options => {
  const args = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    if (argument === '--confirm-stopped') {
      args.set(argument, true);
      continue;
    }
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }
    args.set(argument, value);
  }
  const from = args.get('--from');
  const to = args.get('--to');
  const postgresUrl = args.get('--postgres-url');
  const sqlitePath = args.get('--sqlite-path');
  if ((from !== 'postgres' && from !== 'sqlite') || (to !== 'postgres' && to !== 'sqlite') || from === to) {
    throw new Error('--from and --to must be different values from: postgres, sqlite');
  }
  if (typeof postgresUrl !== 'string' || typeof sqlitePath !== 'string') {
    throw new TypeError('--postgres-url and --sqlite-path are required');
  }
  if (args.get('--confirm-stopped') !== true) {
    throw new Error('Refusing to migrate without --confirm-stopped. Stop every Immich API and worker first.');
  }
  return { from, to, postgresUrl, sqlitePath };
};

const vectorBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  const values = Array.isArray(value)
    ? value.map(Number)
    : String(value)
        .replaceAll(/^\[|\]$/g, '')
        .split(',')
        .filter(Boolean)
        .map(Number);
  return Buffer.from(new Float32Array(values).buffer);
};

const toSqliteValue = (column: DatabaseColumn, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.type === 'vector') {
    return vectorBuffer(value);
  }
  if (column.isArray || column.type === 'jsonb') {
    return JSON.stringify(value);
  }
  if (column.type === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
};

const toPostgresValue = (column: DatabaseColumn, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.type === 'vector') {
    const buffer = vectorBuffer(value);
    return `[${[...new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)].join(',')}]`;
  }
  if ((column.isArray || column.type === 'jsonb') && typeof value === 'string') {
    return JSON.parse(value);
  }
  if (column.type === 'boolean') {
    return value === 1 || value === true;
  }
  return value;
};

const sqliteRows = (database: Database.Database, table: DatabaseTable) =>
  database.prepare(`SELECT * FROM ${quote(table.name)}`).all() as Record<string, unknown>[];
const postgresRows = async (client: Sql, table: DatabaseTable) =>
  (await client.unsafe(`SELECT * FROM ${quote(table.name)}`)) as unknown as Record<string, unknown>[];

const verifySqlite = (database: Database.Database) => {
  const foreignKeys = database.pragma('foreign_key_check') as unknown[];
  if (foreignKeys.length > 0) {
    throw new Error(`SQLite has ${foreignKeys.length} foreign key violation(s)`);
  }
  const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error(`SQLite integrity verification failed: ${JSON.stringify(integrity)}`);
  }
};

const verifyPostgresForeignKeys = async (client: Sql, tables: DatabaseTable[]) => {
  for (const table of tables) {
    for (const constraint of table.constraints) {
      if (constraint.type !== ConstraintType.FOREIGN_KEY || !constraint.synchronize) {
        continue;
      }
      const comparisons = constraint.columnNames
        .map((column, index) => `source.${quote(column)} = target.${quote(constraint.referenceColumnNames[index])}`)
        .join(' AND ');
      const nonNull = constraint.columnNames.map((column) => `source.${quote(column)} IS NOT NULL`).join(' AND ');
      const result = await client.unsafe(
        `SELECT 1 FROM ${quote(table.name)} source LEFT JOIN ${quote(constraint.referenceTableName)} target ON ${comparisons} WHERE ${nonNull} AND target.${quote(constraint.referenceColumnNames[0])} IS NULL LIMIT 1`,
      );
      if (result.length > 0) {
        throw new Error(`PostgreSQL foreign key verification failed: ${constraint.name}`);
      }
    }
  }
};

const validVectorDimension = (value: unknown) => {
  const dimension = Number(value);
  return Number.isInteger(dimension) && dimension >= 1 && dimension <= 2 ** 16 ? dimension : DEFAULT_VECTOR_DIMENSION;
};

const getPostgresClipDimension = async (client: Sql) => {
  const rows = await client.unsafe(`
    SELECT atttypmod AS dimension
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    WHERE relation.relname = 'smart_search' AND attribute.attname = 'embedding'
    LIMIT 1
  `);
  return validVectorDimension(rows[0]?.dimension);
};

const getSqliteClipDimension = (database: Database.Database) => {
  const metadata = database.prepare("SELECT value FROM immich_sqlite_meta WHERE key = 'clip_dimension'").pluck().get();
  if (metadata !== undefined) {
    return validVectorDimension(metadata);
  }
  const embedding = database.prepare('SELECT vec_length(embedding) FROM smart_search LIMIT 1').pluck().get();
  return validVectorDimension(embedding);
};

const migratePostgresToSqlite = async (options: Options, tables: DatabaseTable[]) => {
  if (existsSync(options.sqlitePath)) {
    throw new Error(`SQLite target already exists: ${options.sqlitePath}`);
  }
  const temporaryPath = `${options.sqlitePath}.migrating-${randomUUID()}`;
  const source = postgres(options.postgresUrl, { max: 1 });
  const targetKysely = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: temporaryPath }));
  let targetKyselyDestroyed = false;
  try {
    await initializeSqliteSchema(targetKysely);
    await targetKysely.destroy();
    targetKyselyDestroyed = true;
    const target = createSqliteDatabase(temporaryPath);
    target.pragma('foreign_keys = OFF');
    try {
      const clipDimension = await getPostgresClipDimension(source);
      target
        .prepare(
          "INSERT INTO immich_sqlite_meta (key, value) VALUES ('clip_dimension', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(clipDimension));
      for (const table of tables) {
        const rows = await postgresRows(source, table);
        const columns = getTransferableColumns(table);
        if (rows.length > 0) {
          const names = columns.map((column) => quote(column.name));
          const statement = target.prepare(
            `INSERT INTO ${quote(table.name)} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
          );
          target.transaction((batch: Record<string, unknown>[]) => {
            for (const row of batch) {
              statement.run(columns.map((column) => toSqliteValue(column, row[column.name])));
            }
          })(rows);
        }
        const targetRows = sqliteRows(target, table);
        if (
          rows.length !== targetRows.length ||
          getDatabaseRowsDigest(table, rows) !== getDatabaseRowsDigest(table, targetRows)
        ) {
          throw new Error(`Verification failed while copying ${table.name}`);
        }
        console.log(`${table.name}: ${rows.length}`);
      }
      target.exec("INSERT INTO ocr_search_fts(ocr_search_fts) VALUES('rebuild')");
      target.pragma('foreign_keys = ON');
      verifySqlite(target);
    } finally {
      target.close();
    }
    await rename(temporaryPath, options.sqlitePath);
  } catch (error) {
    if (!targetKyselyDestroyed) {
      await targetKysely.destroy().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await source.end();
  }
};

const runPostgresMigrations = async (db: Kysely<DB>) => {
  const migrator = new Migrator({
    db,
    migrationLockTableName: 'kysely_migrations_lock',
    migrationTableName: 'kysely_migrations',
    provider: new FileMigrationProvider({
      fs: { readdir },
      path: { join },
      // eslint-disable-next-line unicorn/prefer-module
      migrationFolder: join(__dirname, '..', 'schema/migrations'),
    }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }
};

const migrateSqliteToPostgres = async (options: Options, tables: DatabaseTable[]) => {
  if (!existsSync(options.sqlitePath)) {
    throw new Error(`SQLite source does not exist: ${options.sqlitePath}`);
  }
  const source = createSqliteDatabase(options.sqlitePath);
  verifySqlite(source);
  const target = postgres(options.postgresUrl, { max: 1 });
  const targetKysely = new Kysely<DB>(
    getKyselyConfig({ backend: 'postgres', connectionType: 'url', url: options.postgresUrl }),
  );
  try {
    const clipDimension = getSqliteClipDimension(source);
    const existing = await target`SELECT to_regclass('public.user') AS table`;
    if (existing[0]?.table) {
      throw new Error('PostgreSQL target is not empty; use a new database');
    }
    process.env.DB_VECTOR_EXTENSION ??= 'pgvector';
    await runPostgresMigrations(targetKysely);
    if (clipDimension !== DEFAULT_VECTOR_DIMENSION) {
      await target.unsafe('DROP INDEX IF EXISTS clip_index');
      await target.unsafe('ALTER TABLE smart_search DROP CONSTRAINT IF EXISTS dim_size_constraint');
      await target.unsafe(`ALTER TABLE smart_search ALTER COLUMN embedding SET DATA TYPE vector(${clipDimension})`);
    }
    await target.unsafe('SET session_replication_role = replica');
    try {
      for (const table of tables) {
        const rows = sqliteRows(source, table);
        const columns = getTransferableColumns(table);
        const names = columns.map((column) => quote(column.name));
        const statement = `INSERT INTO ${quote(table.name)} (${names.join(', ')}) VALUES (${names.map((_, index) => `$${index + 1}`).join(', ')})`;
        for (const row of rows) {
          await target.unsafe(statement, columns.map((column) => toPostgresValue(column, row[column.name])) as never[]);
        }
        const targetRows = await postgresRows(target, table);
        if (
          rows.length !== targetRows.length ||
          getDatabaseRowsDigest(table, rows) !== getDatabaseRowsDigest(table, targetRows)
        ) {
          throw new Error(`Verification failed while copying ${table.name}`);
        }
        console.log(`${table.name}: ${rows.length}`);
      }
    } finally {
      await target.unsafe('SET session_replication_role = origin');
    }
    await verifyPostgresForeignKeys(target, tables);
    for (const table of tables) {
      const serial = table.columns.find((column) => column.type === 'serial');
      if (serial) {
        await target.unsafe(
          `SELECT setval(pg_get_serial_sequence('${table.name}', '${serial.name}'), coalesce(max(${quote(serial.name)}), 1), max(${quote(serial.name)}) IS NOT NULL) FROM ${quote(table.name)}`,
        );
      }
    }
    if (clipDimension !== DEFAULT_VECTOR_DIMENSION) {
      const vectorExtension = await getVectorExtension(targetKysely);
      await target.unsafe(vectorIndexQuery({ vectorExtension, table: 'smart_search', indexName: VectorIndex.Clip }));
      await target.unsafe('VACUUM ANALYZE smart_search');
    }
  } finally {
    source.close();
    await targetKysely.destroy();
    await target.end();
  }
};

const main = async () => {
  const options = parseOptions();
  const tables = getCurrentDatabaseTables().filter((table) => !backendOwnedTables.has(table.name));
  console.log(`Migrating ${options.from} -> ${options.to}; ${tables.length} tables; source must remain stopped`);
  await (options.from === 'postgres'
    ? migratePostgresToSqlite(options, tables)
    : migrateSqliteToPostgres(options, tables));
  console.log('Database backend migration completed and verified');
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

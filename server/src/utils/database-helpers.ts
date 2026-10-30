import { Expression, sql } from 'kysely';
import {
  jsonArrayFrom as postgresJsonArrayFrom,
  jsonObjectFrom as postgresJsonObjectFrom,
} from 'kysely/helpers/postgres';
import { jsonArrayFrom as sqliteJsonArrayFrom, jsonObjectFrom as sqliteJsonObjectFrom } from 'kysely/helpers/sqlite';
import { SQLITE_JSON_PREFIX, SQLITE_JSON_VALUE_PREFIX } from 'src/sqlite/sqlite-json';

export const isSqliteBackend = () => (process.env.DB_BACKEND ?? 'postgres').toLowerCase() === 'sqlite';

export const withSqliteSyncUpdate = <T extends object>(value: T) =>
  isSqliteBackend()
    ? {
        ...value,
        updatedAt: sql<Date>`immich_now()`,
        updateId: sql<string>`immich_uuid_v7()`,
      }
    : value;

export const jsonArrayFrom: typeof postgresJsonArrayFrom = ((query: Parameters<typeof postgresJsonArrayFrom>[0]) =>
  isSqliteBackend()
    ? sql`${SQLITE_JSON_PREFIX} || ${sqliteJsonArrayFrom(query as never)}`
    : postgresJsonArrayFrom(query)) as typeof postgresJsonArrayFrom;

export const jsonObjectFrom: typeof postgresJsonObjectFrom = ((query: Parameters<typeof postgresJsonObjectFrom>[0]) =>
  isSqliteBackend()
    ? sql`${SQLITE_JSON_PREFIX} || ${sqliteJsonObjectFrom(query as never)}`
    : postgresJsonObjectFrom(query)) as typeof postgresJsonObjectFrom;

export const jsonColumn = <T>(expression: Expression<T>) =>
  isSqliteBackend() ? sql<T>`${SQLITE_JSON_VALUE_PREFIX} || ${expression}` : sql<T>`${expression}`;

export const asDatabaseUuid = (id: string | Expression<string>) =>
  isSqliteBackend() ? sql<string>`${id}` : sql<string>`${id}::uuid`;

export const asDatabaseVector = (embedding: number[]) =>
  isSqliteBackend()
    ? sql<Buffer>`${Buffer.from(new Float32Array(embedding).buffer)}`
    : sql<string>`${`[${embedding}]`}::vector`;

export const asJsonDatabaseVector = (embedding: Expression<string | null>) =>
  isSqliteBackend() ? sql<string>`vec_to_json(${embedding}) || ''` : sql<string>`${embedding}`;

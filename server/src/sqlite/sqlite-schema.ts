import {
  ActionType,
  ConstraintType,
  DatabaseColumn,
  DatabaseConstraint,
  DatabaseIndex,
  DatabaseSchema,
  DatabaseTable,
  schemaFromCode,
} from '@immich/sql-tools';
import { Kysely, sql } from 'kysely';
import 'src/schema';
import { DB } from 'src/schema';
import { immich_uuid_v7 } from 'src/schema/functions';

export const SQLITE_BASELINE_VERSION = 4;
export const SQLITE_MINIMUM_SUPPORTED_VERSION = 1;

const getCurrentDatabaseSchema = () =>
  schemaFromCode({
    overrides: true,
    namingStrategy: 'default',
    uuidFunction: (version) => (version === 7 ? `${immich_uuid_v7.name}()` : 'uuid_generate_v4()'),
  });

export const getCurrentDatabaseTables = () => getCurrentDatabaseSchema().tables.filter((table) => table.synchronize);

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const stringLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

const getEnumValues = () =>
  new Map(
    getCurrentDatabaseSchema()
      .enums.filter((item) => item.synchronize)
      .map((item) => [item.name, item.values]),
  );

const sqliteType = (column: DatabaseColumn) => {
  if (column.isArray || column.type === 'jsonb') {
    return 'TEXT';
  }

  switch (column.type) {
    case 'bigint':
    case 'boolean':
    case 'integer':
    case 'serial':
    case 'smallint': {
      return 'INTEGER';
    }
    case 'bytea':
    case 'vector': {
      return 'BLOB';
    }
    case 'double precision':
    case 'real': {
      return 'REAL';
    }
    default: {
      return 'TEXT';
    }
  }
};

const sqliteDefault = (column: DatabaseColumn) => {
  if (column.default === undefined) {
    return;
  }

  switch (column.default) {
    case 'uuid_generate_v4()': {
      return '(immich_uuid_v4())';
    }
    case 'immich_uuid_v7()': {
      return '(immich_uuid_v7())';
    }
    case 'clock_timestamp()':
    case 'now()': {
      return '(immich_now())';
    }
    case 'true': {
      return '1';
    }
    case 'false': {
      return '0';
    }
    case "'{}'": {
      return column.isArray ? "'[]'" : "'{}'";
    }
    default: {
      return column.default;
    }
  }
};

const sqliteColumnSql = (column: DatabaseColumn, enumValues: Map<string, string[]>) => {
  const parts = [identifier(column.name), sqliteType(column)];
  if (!column.nullable) {
    parts.push('NOT NULL');
  }
  const defaultValue = sqliteDefault(column);
  if (defaultValue !== undefined) {
    parts.push(`DEFAULT ${defaultValue}`);
  }
  const values = column.enumName ? enumValues.get(column.enumName) : undefined;
  if (values) {
    parts.push(`CHECK (${identifier(column.name)} IN (${values.map((value) => stringLiteral(value)).join(', ')}))`);
  }
  return parts.join(' ');
};

const action = (kind: 'UPDATE' | 'DELETE', value?: ActionType) => (value ? ` ON ${kind} ${value}` : '');

const constraintSql = (constraint: DatabaseConstraint) => {
  switch (constraint.type) {
    case ConstraintType.PRIMARY_KEY: {
      return `CONSTRAINT ${identifier(constraint.name)} PRIMARY KEY (${constraint.columnNames.map((name) => identifier(name)).join(', ')})`;
    }
    case ConstraintType.UNIQUE: {
      return `CONSTRAINT ${identifier(constraint.name)} UNIQUE (${constraint.columnNames.map((name) => identifier(name)).join(', ')})`;
    }
    case ConstraintType.FOREIGN_KEY: {
      return `CONSTRAINT ${identifier(constraint.name)} FOREIGN KEY (${constraint.columnNames.map((name) => identifier(name)).join(', ')}) REFERENCES ${identifier(constraint.referenceTableName)} (${constraint.referenceColumnNames.map((name) => identifier(name)).join(', ')})${action('UPDATE', constraint.onUpdate)}${action('DELETE', constraint.onDelete)}`;
    }
    case ConstraintType.CHECK: {
      const expression = constraint.expression.replaceAll(/\btrue\b/gi, '1').replaceAll(/\bfalse\b/gi, '0');
      return `CONSTRAINT ${identifier(constraint.name)} CHECK (${expression})`;
    }
  }
};

const createTableSql = (
  table: DatabaseTable,
  { tableName = table.name, ifNotExists = true }: { tableName?: string; ifNotExists?: boolean } = {},
) => {
  const enumValues = getEnumValues();
  const constraints = table.constraints.filter((constraint) => constraint.synchronize);
  const singleIntegerPrimary =
    constraints.find((constraint) => constraint.type === ConstraintType.PRIMARY_KEY)?.columnNames.length === 1
      ? constraints.find((constraint) => constraint.type === ConstraintType.PRIMARY_KEY)?.columnNames[0]
      : undefined;

  const columns = table.columns
    .filter((column) => column.synchronize || column.type === 'vector')
    .map((column) => {
      if (column.name === singleIntegerPrimary && (column.type === 'serial' || column.identity)) {
        return `${identifier(column.name)} ${sqliteType(column)} PRIMARY KEY AUTOINCREMENT`;
      }
      return sqliteColumnSql(column, enumValues);
    });

  const tableConstraints = constraints
    .filter(
      (constraint) =>
        !(
          constraint.type === ConstraintType.PRIMARY_KEY &&
          constraint.columnNames.length === 1 &&
          constraint.columnNames[0] === singleIntegerPrimary &&
          table.columns.some(
            (column) => column.name === singleIntegerPrimary && (column.type === 'serial' || column.identity),
          )
        ),
    )
    .map((constraint) => constraintSql(constraint));

  return `CREATE TABLE${ifNotExists ? ' IF NOT EXISTS' : ''} ${identifier(tableName)} (\n  ${[
    ...columns,
    ...tableConstraints,
  ].join(',\n  ')}\n)`;
};

const normalizeSql = (value?: string | null) =>
  value
    ?.replaceAll(/\bIF\s+NOT\s+EXISTS\b/gi, '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s+([,)])/g, '$1')
    .replaceAll(/([(,])\s+/g, '$1')
    .replace(/;$/, '')
    .trim();

const sqliteWhere = (where?: string) =>
  where
    ?.replaceAll(/\btrue\b/gi, '1')
    .replaceAll(/\bfalse\b/gi, '0')
    .replaceAll(/\s+IS\s+1/gi, ' = 1');

const sqliteIndexExpression = (index: DatabaseIndex): string | undefined => {
  if (!index.expression) {
    return index.columnNames?.map((name) => identifier(name)).join(', ');
  }
  if (index.using === 'hnsw') {
    return undefined;
  }
  if (index.expression.includes('ll_to_earth_public')) {
    return `${identifier('latitude')}, ${identifier('longitude')}`;
  }
  if (index.expression.includes('gin_trgm_ops')) {
    return index.expression.replace(/\s+gin_trgm_ops$/i, '');
  }
  if (index.name === 'asset_localDateTime_idx') {
    return `substr(${identifier('localDateTime')}, 1, 10)`;
  }
  if (index.name === 'asset_localDateTime_month_idx') {
    return `substr(${identifier('localDateTime')}, 1, 7)`;
  }
  return undefined;
};

const createIndexSql = (table: DatabaseTable, index: DatabaseIndex) => {
  const expression = sqliteIndexExpression(index);
  if (!expression || !index.synchronize) {
    return;
  }
  const where = sqliteWhere(index.where);
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${identifier(index.name)} ON ${identifier(table.name)} (${expression})${where ? ` WHERE ${where}` : ''}`;
};

const primaryWhere = (table: DatabaseTable, prefix: 'OLD' | 'NEW') => {
  const primary = table.constraints.find((constraint) => constraint.type === ConstraintType.PRIMARY_KEY);
  if (!primary || primary.type !== ConstraintType.PRIMARY_KEY) {
    throw new Error(`SQLite trigger requires a primary key on table ${table.name}`);
  }
  return primary.columnNames.map((column) => `${identifier(column)} = ${prefix}.${identifier(column)}`).join(' AND ');
};

const cascadeParentExists = (table: DatabaseTable) => {
  const conditions = table.constraints.flatMap((constraint) => {
    if (constraint.type !== ConstraintType.FOREIGN_KEY || constraint.onDelete !== 'CASCADE') {
      return [];
    }

    const referenceWhere = constraint.columnNames
      .map((column, index) => `${identifier(constraint.referenceColumnNames[index])} = OLD.${identifier(column)}`)
      .join(' AND ');
    const parentExists = `EXISTS (SELECT 1 FROM ${identifier(constraint.referenceTableName)} WHERE ${referenceWhere})`;
    const nullableColumns = constraint.columnNames.filter(
      (columnName) => table.columns.find((column) => column.name === columnName)?.nullable,
    );

    return [
      nullableColumns.length === 0
        ? parentExists
        : `(${nullableColumns.map((column) => `OLD.${identifier(column)} IS NULL`).join(' OR ')} OR ${parentExists})`,
    ];
  });

  return conditions.length > 0 ? conditions.join(' AND ') : undefined;
};

const sqliteTriggerWhen = (table: DatabaseTable, when?: string) => {
  if (!when || !/pg_trigger_depth\(\)\s*=\s*0/i.test(when)) {
    return;
  }

  // PostgreSQL's statement trigger only fires for a top-level delete. SQLite has
  // row triggers and no trigger-depth function, but during an ON DELETE CASCADE
  // the referenced parent has already disappeared. Requiring every CASCADE parent
  // to still exist therefore suppresses only nested cascade audit rows.
  return cascadeParentExists(table);
};

const auditTriggerBody: Record<string, string> = {
  user_delete_audit: 'INSERT INTO "user_audit" ("userId") VALUES (OLD."id");',
  partner_delete_audit:
    'INSERT INTO "partner_audit" ("sharedById", "sharedWithId") VALUES (OLD."sharedById", OLD."sharedWithId");',
  asset_delete_audit: 'INSERT INTO "asset_audit" ("assetId", "ownerId") VALUES (OLD."id", OLD."ownerId");',
  album_asset_delete_audit:
    'INSERT INTO "album_asset_audit" ("albumId", "assetId") SELECT OLD."albumId", OLD."assetId" WHERE EXISTS (SELECT 1 FROM "album" WHERE "id" = OLD."albumId");',
  album_user_delete_audit:
    'INSERT INTO "album_audit" ("albumId", "userId") VALUES (OLD."albumId", OLD."userId"); INSERT INTO "album_user_audit" ("albumId", "userId") VALUES (OLD."albumId", OLD."userId");',
  memory_delete_audit: 'INSERT INTO "memory_audit" ("memoryId", "userId") VALUES (OLD."id", OLD."ownerId");',
  memory_asset_delete_audit:
    'INSERT INTO "memory_asset_audit" ("memoryId", "assetId") SELECT OLD."memoriesId", OLD."assetId" WHERE EXISTS (SELECT 1 FROM "memory" WHERE "id" = OLD."memoriesId");',
  stack_delete_audit: 'INSERT INTO "stack_audit" ("stackId", "userId") VALUES (OLD."id", OLD."ownerId");',
  person_delete_audit: 'INSERT INTO "person_audit" ("personId", "ownerId") VALUES (OLD."id", OLD."ownerId");',
  user_metadata_audit: 'INSERT INTO "user_metadata_audit" ("userId", "key") VALUES (OLD."userId", OLD."key");',
  asset_metadata_audit: 'INSERT INTO "asset_metadata_audit" ("assetId", "key") VALUES (OLD."assetId", OLD."key");',
  asset_face_audit: 'INSERT INTO "asset_face_audit" ("assetFaceId", "assetId") VALUES (OLD."id", OLD."assetId");',
  asset_edit_audit: 'INSERT INTO "asset_edit_audit" ("editId", "assetId") VALUES (OLD."id", OLD."assetId");',
  asset_ocr_delete_audit: 'INSERT INTO "asset_ocr_audit" ("assetId") VALUES (OLD."assetId");',
  asset_edit_insert: 'UPDATE "asset" SET "isEdited" = 1 WHERE "id" = NEW."assetId" AND "isEdited" = 0;',
  asset_edit_delete:
    'UPDATE "asset" SET "isEdited" = 0 WHERE "id" = OLD."assetId" AND "isEdited" = 1 AND NOT EXISTS (SELECT 1 FROM "asset_edit" WHERE "assetId" = OLD."assetId");',
  // SQLite only has row-level triggers. AlbumUserRepository performs the equivalent
  // update so a multi-row album initialization can retain PostgreSQL semantics.
  album_user_after_insert: 'SELECT 1;',
};

const createTriggerSql = (table: DatabaseTable) =>
  table.triggers.flatMap((trigger) => {
    if (!trigger.synchronize) {
      return [];
    }

    if (trigger.functionName === 'updated_at') {
      return [
        `CREATE TRIGGER IF NOT EXISTS ${identifier(trigger.name)} AFTER UPDATE ON ${identifier(table.name)} FOR EACH ROW WHEN NEW.${identifier('updateId')} = OLD.${identifier('updateId')} BEGIN UPDATE ${identifier(table.name)} SET ${identifier('updatedAt')} = immich_now(), ${identifier('updateId')} = immich_uuid_v7() WHERE ${primaryWhere(table, 'NEW')}; END`,
      ];
    }

    const body = auditTriggerBody[trigger.functionName];
    if (!body) {
      throw new Error(`Missing SQLite trigger translation for ${trigger.functionName}`);
    }
    const actionName = trigger.actions[0].toUpperCase();
    const when = sqliteTriggerWhen(table, trigger.when);
    return [
      `CREATE TRIGGER IF NOT EXISTS ${identifier(trigger.name)} AFTER ${actionName} ON ${identifier(table.name)} FOR EACH ROW${when ? ` WHEN ${when}` : ''} BEGIN ${body} END`,
    ];
  });

const specializedSchema = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS "ocr_search_fts" USING fts5("text", content='ocr_search', content_rowid='rowid', tokenize='trigram')`,
  `CREATE TRIGGER IF NOT EXISTS "ocr_search_fts_insert" AFTER INSERT ON "ocr_search" BEGIN INSERT INTO "ocr_search_fts" (rowid, "text") VALUES (NEW.rowid, NEW."text"); END`,
  `CREATE TRIGGER IF NOT EXISTS "ocr_search_fts_delete" AFTER DELETE ON "ocr_search" BEGIN INSERT INTO "ocr_search_fts" ("ocr_search_fts", rowid, "text") VALUES ('delete', OLD.rowid, OLD."text"); END`,
  `CREATE TRIGGER IF NOT EXISTS "ocr_search_fts_update" AFTER UPDATE ON "ocr_search" BEGIN INSERT INTO "ocr_search_fts" ("ocr_search_fts", rowid, "text") VALUES ('delete', OLD.rowid, OLD."text"); INSERT INTO "ocr_search_fts" (rowid, "text") VALUES (NEW.rowid, NEW."text"); END`,
];

const getSqliteTableStatements = () => {
  const tables = getCurrentDatabaseTables();
  return [
    'CREATE TABLE IF NOT EXISTS "immich_sqlite_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS "kysely_migrations" ("name" TEXT PRIMARY KEY, "timestamp" TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS "kysely_migrations_lock" ("id" TEXT PRIMARY KEY, "is_locked" INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS "immich_sqlite_locks" ("name" TEXT PRIMARY KEY, "owner" TEXT NOT NULL, "expiresAt" TEXT NOT NULL)',
    ...tables.map((table) => createTableSql(table)),
  ];
};

const getSqliteDerivedStatements = () => {
  const tables = getCurrentDatabaseTables();
  return [
    ...tables.flatMap((table) => table.indexes.map((index) => createIndexSql(table, index)).filter(Boolean)),
    ...tables.flatMap((table) => createTriggerSql(table)),
    ...specializedSchema,
  ] as string[];
};

export const getSqliteBaselineStatements = () => [...getSqliteTableStatements(), ...getSqliteDerivedStatements()];

const getTableColumns = async (db: Kysely<DB>, tableName: string) => {
  const { rows } = await sql.raw<{ name: string }>(`PRAGMA table_info(${identifier(tableName)})`).execute(db);
  return new Set(rows.map(({ name }) => name));
};

const getTableDefinition = async (db: Kysely<DB>, tableName: string) => {
  const { rows } = await sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${tableName}
  `.execute(db);
  return rows[0]?.sql;
};

const rebuildTable = async (db: Kysely<DB>, table: DatabaseTable) => {
  const existingColumns = await getTableColumns(db, table.name);
  const expectedColumns = table.columns.filter((column) => column.synchronize || column.type === 'vector');
  const { rows } = await sql
    .raw<{ count: number }>(`SELECT count(*) AS count FROM ${identifier(table.name)}`)
    .execute(db);
  const rowCount = rows[0]?.count ?? 0;
  let copyRows = true;

  for (const column of expectedColumns) {
    if (existingColumns.has(column.name)) {
      continue;
    }

    if (column.type === 'vector') {
      // Vector rows are derived ML data and can be regenerated. An older baseline may
      // not have enough information to populate a newly required vector column.
      copyRows = false;
    } else if (!column.nullable && sqliteDefault(column) === undefined && rowCount > 0) {
      throw new Error(
        `SQLite schema migration cannot add required column ${table.name}.${column.name} to a non-empty table`,
      );
    }
  }

  const temporaryTableName = `__immich_rebuild_${table.name}`;
  await sql.raw(`DROP TABLE IF EXISTS ${identifier(temporaryTableName)}`).execute(db);
  await sql.raw(createTableSql(table, { tableName: temporaryTableName, ifNotExists: false })).execute(db);

  const copiedColumns = expectedColumns
    .filter((column) => existingColumns.has(column.name))
    .map((column) => column.name);
  if (copyRows && copiedColumns.length > 0) {
    const columnsSql = copiedColumns.map((column) => identifier(column)).join(', ');
    await sql
      .raw(
        `INSERT INTO ${identifier(temporaryTableName)} (${columnsSql}) SELECT ${columnsSql} FROM ${identifier(table.name)}`,
      )
      .execute(db);
  }

  await sql.raw(`DROP TABLE ${identifier(table.name)}`).execute(db);
  await sql.raw(`ALTER TABLE ${identifier(temporaryTableName)} RENAME TO ${identifier(table.name)}`).execute(db);
};

const reconcileTables = async (db: Kysely<DB>) => {
  const tablesToRebuild: DatabaseTable[] = [];
  for (const table of getCurrentDatabaseTables()) {
    const actual = await getTableDefinition(db, table.name);
    const expected = createTableSql(table);
    if (normalizeSql(actual) !== normalizeSql(expected)) {
      tablesToRebuild.push(table);
    }
  }

  const rebuiltTables = new Set<string>();
  if (tablesToRebuild.length > 0) {
    // Audit triggers on other tables can reference a table while it is being rebuilt.
    // Remove only managed triggers for the duration of the rebuild; indexes remain intact.
    for (const object of getManagedDerivedObjects()) {
      if (object.type === 'trigger') {
        await sql.raw(`DROP TRIGGER IF EXISTS ${identifier(object.name)}`).execute(db);
      }
    }
    for (const table of tablesToRebuild) {
      await rebuildTable(db, table);
      rebuiltTables.add(table.name);
    }
  }
  return rebuiltTables;
};

type ManagedDerivedObject = { type: 'index' | 'trigger'; name: string };
type ManagedDerivedDefinition = ManagedDerivedObject & { sql: string };

const specializedTriggerNames = ['ocr_search_fts_insert', 'ocr_search_fts_delete', 'ocr_search_fts_update'];

const getManagedDerivedDefinitions = (): ManagedDerivedDefinition[] => {
  const tables = getCurrentDatabaseTables();
  return [
    ...tables.flatMap((table) =>
      table.indexes
        .map((index) => ({ index, definition: createIndexSql(table, index) }))
        .filter((item): item is { index: DatabaseIndex; definition: string } => item.definition !== undefined)
        .map(({ index, definition }) => ({ type: 'index' as const, name: index.name, sql: definition })),
    ),
    ...tables.flatMap((table) =>
      table.triggers
        .filter((trigger) => trigger.synchronize)
        .map((trigger) => ({
          type: 'trigger' as const,
          name: trigger.name,
          sql: createTriggerSql({ ...table, triggers: [trigger] })[0],
        })),
    ),
    ...specializedTriggerNames.map((name, index) => ({
      type: 'trigger' as const,
      name,
      sql: specializedSchema[index + 1],
    })),
  ];
};

const getManagedDerivedObjects = (): ManagedDerivedObject[] =>
  getManagedDerivedDefinitions().map(({ type, name }) => ({ type, name }));

const reconcileDerivedSchema = async (db: Kysely<DB>) => {
  const definitions = getManagedDerivedDefinitions();
  const current = definitions.map(({ type, name }) => ({ type, name }));
  const { rows } = await sql<{ value: string }>`
    SELECT value FROM immich_sqlite_meta WHERE key = 'managed_derived_objects'
  `.execute(db);
  const previous = (() => {
    try {
      return rows[0]?.value ? (JSON.parse(rows[0].value) as ManagedDerivedObject[]) : [];
    } catch {
      return [];
    }
  })();

  const currentKeys = new Set(current.map(({ type, name }) => `${type}:${name}`));
  for (const object of previous) {
    if (!currentKeys.has(`${object.type}:${object.name}`)) {
      await sql.raw(`DROP ${object.type.toUpperCase()} IF EXISTS ${identifier(object.name)}`).execute(db);
    }
  }

  const { rows: objects } = await sql<{ name: string; sql: string | null; type: 'index' | 'trigger' }>`
    SELECT name, sql, type FROM sqlite_master WHERE type IN ('index', 'trigger')
  `.execute(db);
  const actual = new Map(objects.map(({ name, sql: definition, type }) => [`${type}:${name}`, definition]));
  for (const definition of definitions) {
    const key = `${definition.type}:${definition.name}`;
    const actualSql = actual.get(key);
    if (actualSql !== undefined && normalizeSql(actualSql) !== normalizeSql(definition.sql)) {
      await sql.raw(`DROP ${definition.type.toUpperCase()} IF EXISTS ${identifier(definition.name)}`).execute(db);
    }
  }

  for (const statement of getSqliteDerivedStatements()) {
    await sql.raw(statement).execute(db);
  }
  await sql`
    INSERT INTO immich_sqlite_meta (key, value)
    VALUES ('managed_derived_objects', ${JSON.stringify(current)})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `.execute(db);
};

export const schemaFromSqlite = async (db: Kysely<DB>, source: DatabaseSchema): Promise<DatabaseSchema> => {
  const { rows: objects } = await sql<{
    name: string;
    sql: string | null;
    type: 'index' | 'table' | 'trigger';
  }>`SELECT name, sql, type FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')`.execute(db);
  const objectSql = new Map(objects.map(({ name, sql: definition, type }) => [`${type}:${name}`, definition]));
  const tables: DatabaseTable[] = [];

  for (const table of source.tables) {
    const tableDefinition = objectSql.get(`table:${table.name}`);
    if (normalizeSql(tableDefinition) !== normalizeSql(createTableSql(table))) {
      continue;
    }
    const columns = await getTableColumns(db, table.name);
    tables.push({
      ...table,
      columns: table.columns.filter((column) => columns.has(column.name)),
      indexes: table.indexes.filter((index) => {
        if (!index.synchronize) {
          return true;
        }
        const expected = createIndexSql(table, index);
        return expected !== undefined && normalizeSql(objectSql.get(`index:${index.name}`)) === normalizeSql(expected);
      }),
      triggers: table.triggers.filter((trigger) => {
        if (!trigger.synchronize) {
          return true;
        }
        const expected = createTriggerSql({ ...table, triggers: [trigger] })[0];
        return normalizeSql(objectSql.get(`trigger:${trigger.name}`)) === normalizeSql(expected);
      }),
    });
  }

  return { ...source, tables };
};

export const initializeSqliteSchema = async (db: Kysely<DB>) => {
  // SQLite executes ON DELETE actions while dropping a referenced parent table, even with
  // defer_foreign_keys enabled. Schema reconciliation uses copy/drop/rename, so foreign keys
  // must be disabled before the transaction and validated before it commits.
  await sql.raw('PRAGMA foreign_keys = OFF').execute(db);
  try {
    await db.transaction().execute(async (transaction) => {
      for (const statement of getSqliteTableStatements()) {
        await sql.raw(statement).execute(transaction);
      }
      const rebuiltTables = await reconcileTables(transaction);
      await reconcileDerivedSchema(transaction);
      if (rebuiltTables.has('ocr_search')) {
        await sql.raw(`INSERT INTO "ocr_search_fts" ("ocr_search_fts") VALUES ('rebuild')`).execute(transaction);
      }
      const { rows: foreignKeyViolations } = await sql`PRAGMA foreign_key_check`.execute(transaction);
      if (foreignKeyViolations.length > 0) {
        throw new Error(`SQLite schema reconciliation created ${foreignKeyViolations.length} foreign key violation(s)`);
      }
      await sql`
        INSERT INTO immich_sqlite_meta (key, value)
        VALUES ('baseline_version', ${SQLITE_BASELINE_VERSION.toString()})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `.execute(transaction);
      await sql`
        INSERT INTO kysely_migrations (name, timestamp)
        VALUES (${`sqlite-baseline-v${SQLITE_BASELINE_VERSION}`}, ${Date.now().toString()})
        ON CONFLICT (name) DO NOTHING
      `.execute(transaction);
    });
  } finally {
    await sql.raw('PRAGMA foreign_keys = ON').execute(db);
  }
};

import {
  KyselyPlugin,
  OperationNodeTransformer,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  PrimitiveValueListNode,
  QueryResult,
  RootOperationNode,
  UnknownRow,
  ValueNode,
} from 'kysely';
import { SQLITE_JSON_PREFIX, SQLITE_JSON_VALUE_PREFIX } from 'src/sqlite/sqlite-json';
import { getCurrentDatabaseTables } from 'src/sqlite/sqlite-schema';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const DATE_COLUMN_TYPES = new Set(['date', 'timestamp', 'timestamp with time zone', 'timestamp without time zone']);

let dateColumns: Set<string> | undefined;
const getDateColumns = () => {
  dateColumns ??= new Set([
    ...getCurrentDatabaseTables().flatMap((table) =>
      table.columns.filter((column) => DATE_COLUMN_TYPES.has(column.type)).map((column) => column.name),
    ),
    // Aggregate aliases that preserve the PostgreSQL Date return type.
    'startDate',
    'endDate',
    'lastModifiedAssetTimestamp',
  ]);
  return dateColumns;
};

const BOOLEAN_COLUMNS = new Set([
  'allowDownload',
  'allowUpload',
  'enabled',
  'hasElevatedPermission',
  'hostFunctions',
  'inTimeline',
  'isActivityEnabled',
  'isAdmin',
  'isArchived',
  'isEdited',
  'isExternal',
  'isFavorite',
  'isHidden',
  'isLiked',
  'isOffline',
  'isPendingSyncReset',
  'isProgressive',
  'isReadOnly',
  'isSaved',
  'isTransparent',
  'isVisible',
  'locked',
  'showExif',
  'shouldChangePassword',
]);

const JSON_COLUMNS = new Set([
  'accDuration',
  'allowedHosts',
  'config',
  'data',
  'exclusionPatterns',
  'importPaths',
  'lockedProperties',
  'metadata',
  'ownDuration',
  'parameters',
  'permissions',
  'pts',
  'schema',
  'tags',
  'templates',
  'types',
  'uiHints',
]);

const parseJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const toSqliteValue = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (Buffer.isBuffer(value) || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value) || (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)) {
    return JSON.stringify(value);
  }
  return value;
};

class SqliteValueTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    const transformed = super.transformValue(node);
    return Object.freeze({ ...transformed, value: toSqliteValue(transformed.value) });
  }

  protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
    return Object.freeze({ ...node, values: Object.freeze(node.values.map((value) => toSqliteValue(value))) });
  }
}

const hydrate = (value: unknown, key?: string): unknown => {
  if (typeof value === 'string' && value.startsWith(SQLITE_JSON_VALUE_PREFIX)) {
    return parseJson(value.slice(SQLITE_JSON_VALUE_PREFIX.length));
  }
  if (typeof value === 'string' && value.startsWith(SQLITE_JSON_PREFIX)) {
    return hydrate(parseJson(value.slice(SQLITE_JSON_PREFIX.length)));
  }
  if (typeof value === 'string' && key && JSON_COLUMNS.has(key)) {
    // JSON columns are opaque application values. Parse the column itself, but do not
    // reinterpret date-looking strings or boolean-looking numbers inside the payload.
    return parseJson(value);
  }
  if (typeof value === 'string' && key && getDateColumns().has(key) && DATE_PATTERN.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : date;
  }
  if (typeof value === 'number' && key && BOOLEAN_COLUMNS.has(key)) {
    return value !== 0;
  }
  if (Array.isArray(value)) {
    return value.map((item) => hydrate(item));
  }
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      (value as Record<string, unknown>)[childKey] = hydrate(childValue, childKey);
    }
  }
  return value;
};

class SqliteTypePlugin implements KyselyPlugin {
  readonly #transformer = new SqliteValueTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node, args.queryId);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    for (const row of args.result.rows) {
      hydrate(row);
    }
    return Promise.resolve(args.result);
  }
}

export const sqlitePlugins = [new SqliteTypePlugin()];

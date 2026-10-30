import { DatabaseColumn, DatabaseTable } from '@immich/sql-tools';
import { createHash } from 'node:crypto';

export const getTransferableColumns = (table: DatabaseTable) =>
  table.columns.filter((column) => column.synchronize || column.type === 'vector');

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
};

const parseJson = (value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const vectorValues = (value: unknown) => {
  if (Buffer.isBuffer(value)) {
    return [...new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4)];
  }
  if (Array.isArray(value)) {
    return value.map(Number);
  }
  return String(value)
    .replaceAll(/^\[|\]$/g, '')
    .split(',')
    .filter(Boolean)
    .map(Number);
};

const canonicalColumnValue = (column: DatabaseColumn, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.type === 'vector') {
    return vectorValues(value);
  }
  if (column.isArray || column.type === 'jsonb') {
    return stableValue(parseJson(value));
  }
  if (column.type === 'boolean') {
    return value === true || value === 1 || value === '1' || value === 'true';
  }
  if (column.type === 'bytea') {
    return Buffer.from(value as Buffer).toString('hex');
  }
  if (column.type.includes('timestamp')) {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
  }
  if (['bigint', 'integer', 'serial', 'smallint', 'double precision', 'real'].includes(column.type)) {
    return String(value);
  }
  return value instanceof Date ? value.toISOString() : value;
};

export const getDatabaseRowsDigest = (table: DatabaseTable, rows: Record<string, unknown>[]) => {
  const columns = getTransferableColumns(table).toSorted((left, right) => left.name.localeCompare(right.name));
  const serializedRows = rows
    .map((row) =>
      JSON.stringify(
        Object.fromEntries(columns.map((column) => [column.name, canonicalColumnValue(column, row[column.name])])),
      ),
    )
    .toSorted();
  const hash = createHash('sha256');
  for (const row of serializedRows) {
    hash.update(row).update('\n');
  }
  return hash.digest('hex');
};

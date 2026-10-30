import { getCurrentDatabaseTables } from 'src/sqlite/sqlite-schema';
import { getDatabaseRowsDigest, getTransferableColumns } from 'src/utils/database-migration';

describe(getTransferableColumns.name, () => {
  it.each(['smart_search', 'face_search'])('includes the required vector column for %s', (tableName) => {
    const table = getCurrentDatabaseTables().find(({ name }) => name === tableName);
    expect(table).toBeDefined();
    expect(getTransferableColumns(table!).map(({ name }) => name)).toContain('embedding');
  });
});

describe(getDatabaseRowsDigest.name, () => {
  it('normalizes backend representations and includes non-primary fields', () => {
    const table = getCurrentDatabaseTables().find(({ name }) => name === 'asset_metadata')!;
    const postgresRow = {
      assetId: 'asset-1',
      key: 'metadata',
      value: { enabled: true, nested: { second: 2, first: 1 } },
      updateId: 'update-1',
      updatedAt: new Date('2026-07-22T01:02:03.000Z'),
    };
    const sqliteRow = {
      ...postgresRow,
      value: '{"nested":{"first":1,"second":2},"enabled":true}',
      updatedAt: '2026-07-22T01:02:03.000Z',
    };

    expect(getDatabaseRowsDigest(table, [sqliteRow])).toBe(getDatabaseRowsDigest(table, [postgresRow]));
    expect(getDatabaseRowsDigest(table, [{ ...sqliteRow, value: '{"enabled":false}' }])).not.toBe(
      getDatabaseRowsDigest(table, [postgresRow]),
    );
  });
});

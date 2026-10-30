import { ChunkedArray, SQLITE_PARAMETER_LIMIT } from 'src/decorators';

describe(ChunkedArray.name, () => {
  const previousBackend = process.env.DB_BACKEND;

  afterEach(() => {
    process.env.DB_BACKEND = previousBackend;
  });

  it('stays below the SQLite parameter limit for primitive values', async () => {
    process.env.DB_BACKEND = 'sqlite';
    class Repository {
      chunks: number[] = [];

      @ChunkedArray()
      execute(items: string[]) {
        this.chunks.push(items.length);
        return Promise.resolve(items);
      }
    }

    const repository = new Repository();
    const items = Array.from({ length: SQLITE_PARAMETER_LIMIT + 1 }, (_, index) => String(index));
    await expect(repository.execute(items)).resolves.toHaveLength(items.length);
    expect(repository.chunks.length).toBeGreaterThan(1);
    expect(Math.max(...repository.chunks)).toBeLessThan(SQLITE_PARAMETER_LIMIT);
  });

  it('accounts for multiple bound fields per inserted row', async () => {
    process.env.DB_BACKEND = 'sqlite';
    class Repository {
      chunks: number[] = [];

      @ChunkedArray({ chunkSize: 30_000 })
      execute(items: Array<{ left: string; right: string }>) {
        this.chunks.push(items.length);
        return Promise.resolve(items);
      }
    }

    const repository = new Repository();
    const items = Array.from({ length: 20_000 }, (_, index) => ({ left: String(index), right: String(index) }));
    await expect(repository.execute(items)).resolves.toHaveLength(items.length);
    expect(repository.chunks).toHaveLength(2);
    expect(Math.max(...repository.chunks) * 2).toBeLessThan(SQLITE_PARAMETER_LIMIT);
  });
});

import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, OrderByDirection, Selectable, ShallowDehydrateObject, sql, Updateable } from 'kysely';
import { DateTime } from 'luxon';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { Chunked, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators';
import { MemorySearchDto } from 'src/dtos/memory.dto';
import { AssetOrderWithRandom, AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { AssetTable } from 'src/schema/tables/asset.table';
import { MemoryTable } from 'src/schema/tables/memory.table';
import { IBulkAsset } from 'src/types';
import { isSqliteBackend, jsonArrayFrom } from 'src/utils/database-helpers';

type RepositoryMemory = Selectable<MemoryTable> & {
  assets: ShallowDehydrateObject<Selectable<AssetTable>>[];
};

@Injectable()
export class MemoryRepository implements IBulkAsset {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async cleanup() {
    await this.db
      .deleteFrom('memory_asset')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset')
            .select(sql`1`.as('1'))
            .whereRef('memory_asset.assetId', '=', 'asset.id')
            .where('asset.visibility', '!=', AssetVisibility.Timeline),
        ),
      )
      .execute();

    return this.db
      .deleteFrom('memory')
      .where('createdAt', '<', DateTime.now().minus({ days: 30 }).toJSDate())
      .where('isSaved', '=', false)
      .execute();
  }

  searchBuilder(ownerId: string, dto: MemorySearchDto) {
    return this.db
      .selectFrom('memory')
      .$if(dto.isSaved !== undefined, (qb) => qb.where('isSaved', '=', dto.isSaved!))
      .$if(dto.type !== undefined, (qb) => qb.where('type', '=', dto.type!))
      .$if(dto.for !== undefined, (qb) =>
        qb
          .where((where) => where.or([where('showAt', 'is', null), where('showAt', '<=', dto.for!)]))
          .where((where) => where.or([where('hideAt', 'is', null), where('hideAt', '>=', dto.for!)])),
      )
      .where('deletedAt', dto.isTrashed ? 'is not' : 'is', null)
      .where('ownerId', '=', ownerId);
  }

  @GenerateSql(
    { params: [DummyValue.UUID, {}] },
    { name: 'date filter', params: [DummyValue.UUID, { for: DummyValue.DATE }] },
  )
  statistics(ownerId: string, dto: MemorySearchDto) {
    return this.searchBuilder(ownerId, dto)
      .select((qb) => qb.fn.countAll<number>().as('total'))
      .executeTakeFirstOrThrow();
  }

  @GenerateSql(
    { params: [DummyValue.UUID, {}] },
    { name: 'date filter', params: [DummyValue.UUID, { for: DummyValue.DATE }] },
  )
  async search(ownerId: string, dto: MemorySearchDto): Promise<RepositoryMemory[]> {
    if (isSqliteBackend()) {
      const rows = await this.searchBuilder(ownerId, dto)
        .selectAll('memory')
        .$call((qb) =>
          dto.order === AssetOrderWithRandom.Random
            ? qb.orderBy(sql`RANDOM()`)
            : qb.orderBy('memoryAt', (dto.order?.toLowerCase() || 'desc') as OrderByDirection),
        )
        .$if(dto.size !== undefined, (qb) => qb.limit(dto.size!))
        .execute();
      return Promise.all(rows.map((row) => this.hydrateSqlite(row, true)));
    }

    return this.searchBuilder(ownerId, dto)
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset')
            .select(columns.assetFull)
            .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
            .whereRef('memory_asset.memoriesId', '=', 'memory.id')
            .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
            .where('asset.deletedAt', 'is', null)
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('asset_face')
                    .innerJoin('person', 'person.id', 'asset_face.personId')
                    .select((eb) => eb.val(1).as('one'))
                    .whereRef('asset_face.assetId', '=', 'asset.id')
                    .where('person.isHidden', '=', true),
                ),
              ),
            )
            .orderBy('asset.fileCreatedAt', 'asc'),
        ).as('assets'),
      )
      .selectAll('memory')
      .$call((qb) =>
        dto.order === AssetOrderWithRandom.Random
          ? qb.orderBy(sql`RANDOM()`)
          : qb.orderBy('memoryAt', (dto.order?.toLowerCase() || 'desc') as OrderByDirection),
      )
      .$if(dto.size !== undefined, (qb) => qb.limit(dto.size!))
      .execute() as unknown as Promise<RepositoryMemory[]>;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async get(id: string): Promise<RepositoryMemory | undefined> {
    if (isSqliteBackend()) {
      const row = await this.db
        .selectFrom('memory')
        .selectAll()
        .where('id', '=', id)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      return row ? this.hydrateSqlite(row) : undefined;
    }
    return this.getByIdBuilder(id).executeTakeFirst() as unknown as Promise<RepositoryMemory | undefined>;
  }

  async create(memory: Insertable<MemoryTable>, assetIds: Set<string>) {
    const id = await this.db.transaction().execute(async (tx) => {
      const { id } = await tx.insertInto('memory').values(memory).returning('id').executeTakeFirstOrThrow();

      if (assetIds.size > 0) {
        const values = [...assetIds].map((assetId) => ({ memoriesId: id, assetId }));
        await tx.insertInto('memory_asset').values(values).execute();
      }

      return id;
    });

    const created = await this.get(id);
    if (!created) {
      throw new Error(`Memory ${id} disappeared after creation`);
    }
    return created;
  }

  @GenerateSql({ params: [DummyValue.UUID, { ownerId: DummyValue.UUID, isSaved: true }] })
  async update(id: string, memory: Updateable<MemoryTable>) {
    await this.db.updateTable('memory').set(memory).where('id', '=', id).execute();
    const updated = await this.get(id);
    if (!updated) {
      throw new Error(`Memory ${id} disappeared after update`);
    }
    return updated;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('memory').where('id', '=', id).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return new Set<string>();
    }

    const results = await this.db
      .selectFrom('memory_asset')
      .select(['assetId'])
      .where('memoriesId', '=', id)
      .where('assetId', 'in', assetIds)
      .execute();

    return new Set(results.map(({ assetId }) => assetId));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async addAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('memory_asset')
      .values(assetIds.map((assetId) => ({ memoriesId: id, assetId })))
      .execute();
  }

  @Chunked({ paramIndex: 1 })
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async removeAssetIds(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    await this.db.deleteFrom('memory_asset').where('memoriesId', '=', id).where('assetId', 'in', assetIds).execute();
  }

  private getByIdBuilder(id: string) {
    return this.db
      .selectFrom('memory')
      .selectAll('memory')
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset')
            .select(columns.assetFull)
            .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
            .whereRef('memory_asset.memoriesId', '=', 'memory.id')
            .orderBy('asset.fileCreatedAt', 'asc')
            .where('asset.visibility', '=', sql.lit(AssetVisibility.Timeline))
            .where('asset.deletedAt', 'is', null),
        ).as('assets'),
      )
      .where('id', '=', id)
      .where('deletedAt', 'is', null);
  }

  private async hydrateSqlite(row: Selectable<MemoryTable>, excludeHiddenPeople = false): Promise<RepositoryMemory> {
    const assets = await this.db
      .selectFrom('asset')
      .select(columns.assetFull)
      .innerJoin('memory_asset', 'asset.id', 'memory_asset.assetId')
      .where('memory_asset.memoriesId', '=', row.id)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.deletedAt', 'is', null)
      .$if(excludeHiddenPeople, (query) =>
        query.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_face')
                .innerJoin('person', 'person.id', 'asset_face.personId')
                .select(sql`1`.as('1'))
                .whereRef('asset_face.assetId', '=', 'asset.id')
                .where('person.isHidden', '=', true),
            ),
          ),
        ),
      )
      .orderBy('asset.fileCreatedAt', 'asc')
      .execute();
    return { ...row, assets } as unknown as RepositoryMemory;
  }
}

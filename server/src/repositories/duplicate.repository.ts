import { Injectable } from '@nestjs/common';
import { Kysely, NotNull, Selectable, ShallowDehydrateObject, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { Chunked, DummyValue, GenerateSql } from 'src/decorators';
import { MapAsset } from 'src/dtos/asset-response.dto';
import { AssetType, VectorIndex } from 'src/enum';
import { probes } from 'src/repositories/database.repository';
import { DB } from 'src/schema';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { asUuid, withDefaultVisibility, withExif } from 'src/utils/database';
import { isSqliteBackend, jsonArrayFrom } from 'src/utils/database-helpers';

// Maximum number of candidate duplicates to return from vector search
const DUPLICATE_SEARCH_LIMIT = 64;

interface DuplicateSearch {
  assetId: string;
  embedding: string;
  maxDistance: number;
  type: AssetType;
  userIds: string[];
}

interface DuplicateMergeOptions {
  targetId: string | null;
  assetIds: string[];
  sourceIds: string[];
}

@Injectable()
export class DuplicateRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  async getAll(userId: string) {
    if (isSqliteBackend()) {
      const groups = await this.db
        .selectFrom('asset')
        .$call(withDefaultVisibility)
        .select('duplicateId')
        .where('ownerId', '=', userId)
        .where('duplicateId', 'is not', null)
        .where('deletedAt', 'is', null)
        .where('stackId', 'is', null)
        .groupBy('duplicateId')
        .having((eb) => eb.fn.count('id'), '>', 1)
        .$narrowType<{ duplicateId: NotNull }>()
        .execute();
      return Promise.all(
        groups.map(async ({ duplicateId }) => ({ duplicateId, assets: await this.getSqliteAssets(duplicateId) })),
      );
    }

    return (
      this.db
        .with('duplicates', (qb) =>
          qb
            .selectFrom('asset')
            .$call(withDefaultVisibility)
            // Use innerJoinLateral to build a composite object per asset that includes
            // exifInfo and tags. This "asset2" object is then aggregated via jsonAgg.
            // Tags must be included here (not via separate joins) so they appear in the
            // final MapAsset[] output - needed for tag synchronization during resolution.
            .innerJoinLateral(
              (qb) =>
                qb
                  .selectFrom('asset_exif')
                  .selectAll('asset')
                  .select((eb) =>
                    eb.fn
                      .toJson('asset_exif')
                      .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>()
                      .as('exifInfo'),
                  )

                  .select((eb) =>
                    jsonArrayFrom(
                      eb
                        .selectFrom('tag')
                        .select(columns.tag)
                        .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
                        .whereRef('tag_asset.assetId', '=', 'asset.id'),
                    ).as('tags'),
                  )
                  .whereRef('asset_exif.assetId', '=', 'asset.id')
                  .as('asset2'),
              (join) => join.onTrue(),
            )
            .select('asset.duplicateId')
            .select((eb) =>
              eb.fn.jsonAgg('asset2').orderBy('asset.localDateTime', 'asc').$castTo<MapAsset[]>().as('assets'),
            )
            .where('asset.ownerId', '=', asUuid(userId))
            .where('asset.duplicateId', 'is not', null)
            .$narrowType<{ duplicateId: NotNull }>()
            .where('asset.deletedAt', 'is', null)
            .where('asset.stackId', 'is', null)
            .groupBy('asset.duplicateId'),
        )
        .selectFrom('duplicates')
        .selectAll()
        // Filter out singleton groups (only 1 asset) directly in the query
        .where((eb) => eb(eb.fn('json_array_length', ['assets']), '>', 1))
        .execute()
    );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async cleanupSingletonGroups(userId: string): Promise<void> {
    // Remove duplicateId from assets that are the only member of their duplicate group
    await this.db
      .with('singletons', (qb) =>
        qb
          .selectFrom('asset')
          .select('duplicateId')
          .where('ownerId', '=', asUuid(userId))
          .where('duplicateId', 'is not', null)
          .$narrowType<{ duplicateId: NotNull }>()
          .where('deletedAt', 'is', null)
          .where('stackId', 'is', null)
          .groupBy('duplicateId')
          .having((eb) => eb.fn.count('id'), '=', 1),
      )
      .updateTable('asset')
      .set({ duplicateId: null })
      .from('singletons')
      .whereRef('asset.duplicateId', '=', 'singletons.duplicateId')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async get(duplicateId: string): Promise<{ duplicateId: string; assets: MapAsset[] } | undefined> {
    if (isSqliteBackend()) {
      const assets = await this.getSqliteAssets(duplicateId);
      return assets.length > 0 ? { duplicateId, assets } : undefined;
    }

    const result = await this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      // Use innerJoinLateral to build a composite object per asset that includes
      // exifInfo and tags. This "asset2" object is then aggregated via jsonAgg.
      // Tags must be included here (not via separate joins) so they appear in the
      // final MapAsset[] output - needed for tag synchronization during resolution.
      .innerJoinLateral(
        (qb) =>
          qb
            .selectFrom('asset_exif')
            .selectAll('asset')
            .select((eb) => eb.fn.toJson('asset_exif').as('exifInfo'))
            .select((eb) =>
              jsonArrayFrom(
                eb
                  .selectFrom('tag')
                  .select(columns.tag)
                  .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
                  .whereRef('tag_asset.assetId', '=', 'asset.id'),
              ).as('tags'),
            )
            .whereRef('asset_exif.assetId', '=', 'asset.id')
            .as('asset2'),
        (join) => join.onTrue(),
      )
      .select('asset.duplicateId')
      .select((eb) => eb.fn.jsonAgg('asset2').orderBy('asset.localDateTime', 'asc').$castTo<MapAsset[]>().as('assets'))
      .where('asset.duplicateId', '=', asUuid(duplicateId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.stackId', 'is', null)
      .groupBy('asset.duplicateId')
      .executeTakeFirst();

    if (!result || !result.duplicateId) {
      return;
    }

    return { duplicateId: result.duplicateId, assets: result.assets };
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async delete(userId: string, id: string): Promise<void> {
    await this.db
      .updateTable('asset')
      .set({ duplicateId: null })
      .where('ownerId', '=', userId)
      .where('duplicateId', '=', id)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  async deleteAll(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .updateTable('asset')
      .set({ duplicateId: null })
      .where('ownerId', '=', userId)
      .where('duplicateId', 'in', ids)
      .execute();
  }

  @GenerateSql({
    params: [
      {
        assetId: DummyValue.UUID,
        embedding: DummyValue.VECTOR,
        maxDistance: 0.6,
        type: AssetType.Image,
        userIds: [DummyValue.UUID],
      },
    ],
  })
  search({ assetId, embedding, maxDistance, type, userIds }: DuplicateSearch) {
    if (isSqliteBackend()) {
      return this.db
        .selectFrom('asset')
        .$call(withDefaultVisibility)
        .select([
          'asset.id as assetId',
          'asset.duplicateId',
          sql<number>`vec_distance_cosine(smart_search.embedding, vec_f32(${embedding}))`.as('distance'),
        ])
        .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
        .where('asset.ownerId', 'in', userIds)
        .where('asset.deletedAt', 'is', null)
        .where('asset.type', '=', type)
        .where('asset.id', '!=', assetId)
        .where('asset.stackId', 'is', null)
        .where(sql<number>`vec_distance_cosine(smart_search.embedding, vec_f32(${embedding}))`, '<=', maxDistance)
        .orderBy('distance')
        .limit(DUPLICATE_SEARCH_LIMIT)
        .execute();
    }

    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Clip])}`.execute(trx);
      return await trx
        .with('cte', (qb) =>
          qb
            .selectFrom('asset')
            .$call(withDefaultVisibility)
            .select([
              'asset.id as assetId',
              'asset.duplicateId',
              sql<number>`smart_search.embedding <=> ${embedding}`.as('distance'),
            ])
            .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
            .where('asset.ownerId', 'in', userIds)
            .where('asset.deletedAt', 'is', null)
            .where('asset.type', '=', type)
            .where('asset.id', '!=', asUuid(assetId))
            .where('asset.stackId', 'is', null)
            .orderBy('distance')
            .limit(DUPLICATE_SEARCH_LIMIT),
        )
        .selectFrom('cte')
        .selectAll()
        .where('cte.distance', '<=', maxDistance as number)
        .execute();
    });
  }

  @GenerateSql({
    params: [{ targetDuplicateId: DummyValue.UUID, duplicateIds: [DummyValue.UUID], assetIds: [DummyValue.UUID] }],
  })
  async merge(options: DuplicateMergeOptions): Promise<void> {
    await this.db
      .updateTable('asset')
      .set({ duplicateId: options.targetId })
      .where((eb) => eb.or([eb('duplicateId', 'in', options.sourceIds), eb('id', 'in', options.assetIds)]))
      .execute();
  }

  private getSqliteAssets(duplicateId: string): Promise<MapAsset[]> {
    return this.db
      .selectFrom('asset')
      .$call(withDefaultVisibility)
      .selectAll('asset')
      .$call(withExif)
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('tag')
            .select(columns.tag)
            .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
            .whereRef('tag_asset.assetId', '=', 'asset.id'),
        ).as('tags'),
      )
      .where('asset.duplicateId', '=', duplicateId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.stackId', 'is', null)
      .orderBy('asset.localDateTime', 'asc')
      .$castTo<MapAsset>()
      .execute();
  }
}

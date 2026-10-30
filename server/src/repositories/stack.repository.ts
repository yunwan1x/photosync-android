import { Injectable } from '@nestjs/common';
import {
  ExpressionBuilder,
  Insertable,
  Kysely,
  Selectable,
  ShallowDehydrateObject,
  sql,
  Transaction,
  Updateable,
} from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { DummyValue, GenerateSql } from 'src/decorators';
import { DB } from 'src/schema';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { AssetTable } from 'src/schema/tables/asset.table';
import { StackTable } from 'src/schema/tables/stack.table';
import { TagTable } from 'src/schema/tables/tag.table';
import { asUuid, withDefaultVisibility, withExif } from 'src/utils/database';
import { isSqliteBackend, jsonArrayFrom, withSqliteSyncUpdate } from 'src/utils/database-helpers';

export interface StackSearch {
  ownerId: string;
  primaryAssetId?: string;
}

type RepositoryStackAsset = ShallowDehydrateObject<Selectable<AssetTable>> & {
  exifInfo?: ShallowDehydrateObject<Selectable<AssetExifTable>> | null;
  tags?: ShallowDehydrateObject<Selectable<TagTable>>[];
};
type RepositoryStack = Selectable<StackTable> & { assets: RepositoryStackAsset[] };

const withAssets = (eb: ExpressionBuilder<DB, 'stack'>, withTags = false) => {
  return jsonArrayFrom(
    eb
      .selectFrom('asset')
      .select(columns.assetFull)
      .$call(withExif)
      .$if(withTags, (eb) =>
        eb.select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('tag')
              .select(columns.tag)
              .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
              .whereRef('tag_asset.assetId', '=', 'asset.id'),
          ).as('tags'),
        ),
      )
      .where('asset.deletedAt', 'is', null)
      .where(sql<boolean>`asset."stackId" = stack.id`)
      .$call(withDefaultVisibility),
  ).as('assets');
};

@Injectable()
export class StackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID }] })
  async search(query: StackSearch): Promise<RepositoryStack[]> {
    const rows = await this.db
      .selectFrom('stack')
      .selectAll('stack')
      .$if(!isSqliteBackend(), (query) => query.select(withAssets))
      .where('stack.ownerId', '=', query.ownerId)
      .$if(!!query.primaryAssetId, (eb) => eb.where('stack.primaryAssetId', '=', query.primaryAssetId!))
      .execute();
    if (!isSqliteBackend()) {
      return rows as unknown as RepositoryStack[];
    }
    return Promise.all(rows.map((row) => this.hydrateSqlite(this.db, row)));
  }

  async create(entity: Omit<Insertable<StackTable>, 'primaryAssetId'>, assetIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      const stacks = await tx
        .selectFrom('stack')
        .where('stack.ownerId', '=', entity.ownerId)
        .where('stack.primaryAssetId', 'in', assetIds)
        .select('stack.id')
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset')
              .select('asset.id')
              .whereRef('asset.stackId', '=', 'stack.id')
              .where('asset.deletedAt', 'is', null),
          ).as('assets'),
        )
        .execute();

      const uniqueIds = new Set<string>(assetIds);

      // children
      for (const stack of stacks) {
        if (stack.assets && stack.assets.length > 0) {
          for (const asset of stack.assets) {
            uniqueIds.add(asset.id);
          }
        }
      }

      if (stacks.length > 0) {
        await tx
          .deleteFrom('stack')
          .where(
            'id',
            'in',
            stacks.map((stack) => stack.id),
          )
          .execute();
      }

      const newRecord = await tx
        .insertInto('stack')
        .values({ ...entity, primaryAssetId: assetIds[0] })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .updateTable('asset')
        .set({
          stackId: newRecord.id,
          updatedAt: new Date(),
        })
        .where('id', 'in', [...uniqueIds])
        .execute();

      const row = await tx
        .selectFrom('stack')
        .selectAll('stack')
        .$if(!isSqliteBackend(), (query) => query.select(withAssets))
        .where('id', '=', newRecord.id)
        .executeTakeFirstOrThrow();
      return isSqliteBackend() ? this.hydrateSqlite(tx, row) : (row as unknown as RepositoryStack);
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('stack').where('id', '=', asUuid(id)).execute();
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.db.deleteFrom('stack').where('id', 'in', ids).execute();
  }

  async update(id: string, entity: Updateable<StackTable>): Promise<RepositoryStack> {
    const row = await this.db
      .updateTable('stack')
      .set(withSqliteSyncUpdate(entity))
      .where('id', '=', asUuid(id))
      .returningAll('stack')
      .$if(!isSqliteBackend(), (query) => query.returning((eb) => withAssets(eb, true)))
      .executeTakeFirstOrThrow();
    return isSqliteBackend() ? this.hydrateSqlite(this.db, row, true) : (row as unknown as RepositoryStack);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getById(id: string): Promise<RepositoryStack | undefined> {
    const row = await this.db
      .selectFrom('stack')
      .selectAll()
      .$if(!isSqliteBackend(), (query) => query.select((eb) => withAssets(eb, true)))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    return isSqliteBackend() ? this.hydrateSqlite(this.db, row, true) : (row as unknown as RepositoryStack);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getForAssetRemoval(assetId: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('stack', 'stack.id', 'asset.stackId')
      .select(['stackId as id', 'stack.primaryAssetId'])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ sourceId: DummyValue.UUID, targetId: DummyValue.UUID }] })
  merge({ sourceId, targetId }: { sourceId: string; targetId: string }) {
    return this.db.updateTable('asset').set({ stackId: targetId }).where('asset.stackId', '=', sourceId).execute();
  }

  private async hydrateSqlite(
    db: Kysely<DB> | Transaction<DB>,
    row: Selectable<StackTable>,
    withTags = false,
  ): Promise<RepositoryStack> {
    const assets = await db
      .selectFrom('asset')
      .select(columns.assetFull)
      .$call(withExif)
      .where('asset.stackId', '=', row.id)
      .where('asset.deletedAt', 'is', null)
      .$call(withDefaultVisibility)
      .execute();

    if (!withTags) {
      return { ...row, assets } as unknown as RepositoryStack;
    }

    const hydrated = await Promise.all(
      assets.map(async (asset) => {
        const tags = await db
          .selectFrom('tag')
          .select(columns.tag)
          .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
          .where('tag_asset.assetId', '=', asset.id)
          .execute();
        return { ...asset, tags };
      }),
    );
    return { ...row, assets: hydrated } as unknown as RepositoryStack;
  }
}

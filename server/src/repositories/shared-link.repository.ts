import { Injectable } from '@nestjs/common';
import { ExpressionBuilder, Insertable, Kysely, Selectable, ShallowDehydrateObject, sql, Updateable } from 'kysely';
import _ from 'lodash';
import { InjectKysely } from 'nestjs-kysely';
import { Album, columns, SharedLink } from 'src/database';
import { ChunkedArray, DummyValue, GenerateSql } from 'src/decorators';
import { AlbumUserRole, SharedLinkType } from 'src/enum';
import { DB } from 'src/schema';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { AssetTable } from 'src/schema/tables/asset.table';
import { SharedLinkTable } from 'src/schema/tables/shared-link.table';
import { withExif } from 'src/utils/database';
import { isSqliteBackend, jsonArrayFrom, jsonObjectFrom } from 'src/utils/database-helpers';

export type SharedLinkSearchOptions = {
  userId: string;
  id?: string;
  albumId?: string;
};

const withSharedAssets = (eb: ExpressionBuilder<DB, 'shared_link'>) => {
  return eb
    .selectFrom('shared_link_asset')
    .whereRef('shared_link.id', '=', 'shared_link_asset.sharedLinkId')
    .innerJoin('asset', 'asset.id', 'shared_link_asset.assetId')
    .where('asset.deletedAt', 'is', null)
    .selectAll('asset')
    .orderBy('asset.fileCreatedAt', 'asc');
};

export const withExifInfo = (eb: ExpressionBuilder<DB, 'asset'>) => {
  return eb
    .selectFrom('asset_exif')
    .select(columns.exif)
    .whereRef('asset_exif.assetId', '=', 'asset.id')
    .as('exifInfo');
};

const withAlbumOwner = (eb: ExpressionBuilder<DB, 'album'>) => {
  return eb
    .selectFrom('user')
    .select(columns.user)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('album_user')
          .select(sql`1`.as('1'))
          .where('album_user.role', '=', sql.lit(AlbumUserRole.Owner))
          .whereRef('album_user.albumId', '=', 'album.id')
          .whereRef('album_user.userId', '=', 'user.id'),
      ),
    )
    .where('user.deletedAt', 'is', null)
    .as('owner');
};

const withSharedLinkAlbum = (eb: ExpressionBuilder<DB, 'shared_link'>) => {
  return eb
    .selectFrom('album')
    .selectAll('album')
    .whereRef('album.id', '=', 'shared_link.albumId')
    .where('album.deletedAt', 'is', null);
};

@Injectable()
export class SharedLinkRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async get(userId: string, id: string): Promise<SharedLink | undefined> {
    if (isSqliteBackend()) {
      const link = await this.db
        .selectFrom('shared_link')
        .selectAll()
        .where('id', '=', id)
        .where('userId', '=', userId)
        .executeTakeFirst();
      return link ? this.hydrateSqlite(link) : undefined;
    }

    return this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .select((eb) =>
        jsonArrayFrom(
          withSharedAssets(eb)
            .innerJoinLateral(withExifInfo, (join) => join.onTrue())
            .select((eb) => eb.fn.toJson('exifInfo').as('exifInfo')),
        ).as('assets'),
      )
      .leftJoinLateral(
        (eb) =>
          withSharedLinkAlbum(eb)
            .leftJoin('album_asset', 'album_asset.albumId', 'album.id')
            .leftJoinLateral(
              (eb) =>
                eb
                  .selectFrom('asset')
                  .selectAll('asset')
                  .whereRef('album_asset.assetId', '=', 'asset.id')
                  .where('asset.deletedAt', 'is', null)
                  .innerJoinLateral(withExifInfo, (join) => join.onTrue())
                  .select((eb) => eb.fn.toJson(eb.table('exifInfo')).as('exifInfo'))
                  .orderBy('asset.fileCreatedAt', 'asc')
                  .as('assets'),
              (join) => join.onTrue(),
            )
            .innerJoinLateral(withAlbumOwner, (join) => join.onTrue())
            .select((eb) =>
              eb.fn
                .coalesce(
                  eb.fn
                    .jsonAgg('assets')
                    .orderBy('assets.fileCreatedAt', 'asc')
                    .filterWhere('assets.id', 'is not', null),

                  sql`'[]'`,
                )
                .as('assets'),
            )
            .select((eb) => eb.fn.toJson('owner').as('owner'))
            .groupBy(['album.id', sql`"owner".*`])
            .as('album'),
        (join) => join.onTrue(),
      )
      .select((eb) => eb.fn.toJson(eb.table('album')).$castTo<ShallowDehydrateObject<Album> | null>().as('album'))
      .where('shared_link.id', '=', id)
      .where('shared_link.userId', '=', userId)
      .where((eb) => eb.or([eb('shared_link.type', '=', SharedLinkType.Individual), eb('album.id', 'is not', null)]))
      .orderBy('shared_link.createdAt', 'desc')
      .executeTakeFirst() as unknown as Promise<SharedLink | undefined>;
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, albumId: DummyValue.UUID }] })
  async getAll({ userId, id, albumId }: SharedLinkSearchOptions): Promise<SharedLink[]> {
    if (isSqliteBackend()) {
      const links = await this.db
        .selectFrom('shared_link')
        .selectAll()
        .where('userId', '=', userId)
        .$if(!!albumId, (query) => query.where('albumId', '=', albumId!))
        .$if(!!id, (query) => query.where('id', '=', id!))
        .orderBy('createdAt', 'desc')
        .execute();
      const hydrated = await Promise.all(links.map((link) => this.hydrateSqlite(link, true)));
      return hydrated.filter((link): link is SharedLink => !!link);
    }

    return this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .select((eb) => jsonArrayFrom(withSharedAssets(eb).limit(1)).as('assets'))
      .where('shared_link.userId', '=', userId)
      .leftJoinLateral(
        (eb) =>
          withSharedLinkAlbum(eb)
            .innerJoinLateral(withAlbumOwner, (join) => join.onTrue())
            .select((eb) => eb.fn.toJson('owner').as('owner'))
            .as('album'),
        (join) => join.onTrue(),
      )
      .select((eb) => eb.fn.toJson('album').$castTo<ShallowDehydrateObject<Album> | null>().as('album'))
      .where((eb) => eb.or([eb('shared_link.type', '=', SharedLinkType.Individual), eb('album.id', 'is not', null)]))
      .$if(!!albumId, (eb) => eb.where('shared_link.albumId', '=', albumId!))
      .$if(!!id, (eb) => eb.where('shared_link.id', '=', id!))
      .orderBy('shared_link.createdAt', 'desc')
      .execute() as unknown as Promise<SharedLink[]>;
  }

  @GenerateSql({ params: [DummyValue.BUFFER] })
  getByKey(key: Buffer) {
    return this.authBuilder().where('shared_link.key', '=', key).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.BUFFER] })
  getBySlug(slug: string) {
    return this.authBuilder().where('shared_link.slug', '=', slug).executeTakeFirst();
  }

  private authBuilder() {
    return this.db
      .selectFrom('shared_link')
      .leftJoin('album', 'album.id', 'shared_link.albumId')
      .where('album.deletedAt', 'is', null)
      .select((eb) => [
        'shared_link.id',
        'shared_link.userId',
        'shared_link.albumId',
        'shared_link.expiresAt',
        'shared_link.showExif',
        'shared_link.allowUpload',
        'shared_link.allowDownload',
        'shared_link.password',
        jsonObjectFrom(
          eb.selectFrom('user').select(columns.authUser).whereRef('user.id', '=', 'shared_link.userId'),
        ).as('user'),
      ])
      .where((eb) => eb.or([eb('shared_link.type', '=', SharedLinkType.Individual), eb('album.id', 'is not', null)]));
  }

  async create(entity: Insertable<SharedLinkTable> & { assetIds?: string[] }) {
    const { id } = await this.db
      .insertInto('shared_link')
      .values(_.omit(entity, 'assetIds'))
      .returningAll()
      .executeTakeFirstOrThrow();

    if (entity.assetIds && entity.assetIds.length > 0) {
      await this.db
        .insertInto('shared_link_asset')
        .values(entity.assetIds!.map((assetId) => ({ assetId, sharedLinkId: id })))
        .execute();
    }

    return this.getSharedLinks(id);
  }

  async update(entity: Updateable<SharedLinkTable> & { id: string; assetIds?: string[] }) {
    const { id } = await this.db
      .updateTable('shared_link')
      .set(_.omit(entity, 'assets', 'album', 'assetIds'))
      .where('shared_link.id', '=', entity.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (entity.assetIds && entity.assetIds.length > 0) {
      await this.db
        .insertInto('shared_link_asset')
        .values(entity.assetIds!.map((assetId) => ({ assetId, sharedLinkId: id })))
        .execute();
    }

    return this.getSharedLinks(id);
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('shared_link').where('shared_link.id', '=', id).execute();
  }

  @ChunkedArray({ paramIndex: 1 })
  async addAssets(id: string, assetIds: string[]) {
    if (assetIds.length === 0) {
      return [];
    }

    return await this.db
      .insertInto('shared_link_asset')
      .values(assetIds.map((assetId) => ({ assetId, sharedLinkId: id })))
      .onConflict((oc) => oc.doNothing())
      .returning(['shared_link_asset.assetId'])
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  private getSharedLinks(id: string): Promise<SharedLink> {
    if (isSqliteBackend()) {
      return this.db
        .selectFrom('shared_link')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
        .then(async (link) => {
          const hydrated = await this.hydrateSqlite(link);
          if (!hydrated) {
            throw new Error(`Shared link ${id} references a missing album`);
          }
          return hydrated;
        });
    }

    return this.db
      .selectFrom('shared_link')
      .selectAll('shared_link')
      .where('shared_link.id', '=', id)
      .leftJoin('shared_link_asset', 'shared_link_asset.sharedLinkId', 'shared_link.id')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('asset')
            .whereRef('asset.id', '=', 'shared_link_asset.assetId')
            .selectAll('asset')
            .innerJoinLateral(withExifInfo, (join) => join.onTrue())
            .as('assets'),
        (join) => join.onTrue(),
      )
      .select((eb) =>
        eb.fn
          .coalesce(eb.fn.jsonAgg('assets').filterWhere('assets.id', 'is not', null), sql`'[]'`)
          .$castTo<
            (ShallowDehydrateObject<Selectable<AssetTable>> & {
              exifInfo: ShallowDehydrateObject<Selectable<AssetExifTable>>;
            })[]
          >()
          .as('assets'),
      )
      .groupBy('shared_link.id')
      .executeTakeFirstOrThrow() as unknown as Promise<SharedLink>;
  }

  private async hydrateSqlite(link: Selectable<SharedLinkTable>, limitAssets = false): Promise<SharedLink | undefined> {
    const assets = await this.db
      .selectFrom('asset')
      .innerJoin('shared_link_asset', 'shared_link_asset.assetId', 'asset.id')
      .select(columns.assetFull)
      .where('shared_link_asset.sharedLinkId', '=', link.id)
      .where('asset.deletedAt', 'is', null)
      .$call(withExif)
      .orderBy('asset.fileCreatedAt', 'asc')
      .$if(limitAssets, (query) => query.limit(1))
      .execute();

    let album: any = null;
    if (link.albumId) {
      const albumRow = await this.db
        .selectFrom('album')
        .selectAll()
        .where('id', '=', link.albumId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (albumRow) {
        const owner = await this.db
          .selectFrom('user')
          .innerJoin('album_user', 'album_user.userId', 'user.id')
          .select(columns.user)
          .where('album_user.albumId', '=', albumRow.id)
          .where('album_user.role', '=', AlbumUserRole.Owner)
          .where('user.deletedAt', 'is', null)
          .executeTakeFirst();
        const albumAssets = await this.db
          .selectFrom('asset')
          .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
          .select(columns.assetFull)
          .where('album_asset.albumId', '=', albumRow.id)
          .where('asset.deletedAt', 'is', null)
          .$call(withExif)
          .orderBy('asset.fileCreatedAt', 'asc')
          .execute();
        album = { ...albumRow, owner, assets: albumAssets };
      }
    }
    if (link.type !== SharedLinkType.Individual && !album) {
      return undefined;
    }
    return { ...link, assets, album } as unknown as SharedLink;
  }
}

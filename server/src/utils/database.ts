import { createPostgres } from '@immich/sql-tools';
import {
  AliasedRawBuilder,
  DeduplicateJoinsPlugin,
  ExpressionBuilder,
  Kysely,
  KyselyConfig,
  NotNull,
  Selectable,
  SelectQueryBuilder,
  ShallowDehydrateObject,
  sql,
  SqliteDialect,
} from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { Notice, PostgresError } from 'postgres';
import { columns, lockableProperties, LockableProperty, Person } from 'src/database';
import { ImmichDatabaseConfig } from 'src/database-config';
import { AssetEditActionItem } from 'src/dtos/editing.dto';
import { AssetFileType, AssetOrderBy, AssetVisibility, DatabaseExtension, ExifOrientation } from 'src/enum';
import { AssetSearchBuilderOptions } from 'src/repositories/search.repository';
import { DB } from 'src/schema';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { createSqliteDatabase } from 'src/sqlite/sqlite-database';
import { sqlitePlugins } from 'src/sqlite/sqlite-plugin';
import { AudioStreamInfo, VectorExtension, VideoFormat, VideoPacketInfo, VideoStreamInfo } from 'src/types';
import {
  asDatabaseUuid,
  asJsonDatabaseVector,
  isSqliteBackend,
  jsonArrayFrom,
  jsonObjectFrom,
} from 'src/utils/database-helpers';

export const getKyselyConfig = (config: ImmichDatabaseConfig): KyselyConfig => {
  if (config.backend === 'sqlite') {
    return {
      dialect: new SqliteDialect({ database: () => Promise.resolve(createSqliteDatabase(config.path)) }),
      plugins: sqlitePlugins,
      log: logDatabaseError,
    };
  }

  const { backend: _, ...connection } = config;

  return {
    dialect: new PostgresJSDialect({
      postgres: createPostgres({
        connection,
        onNotice: (notice: Notice) => {
          if (notice['severity'] !== 'NOTICE') {
            console.warn('Postgres notice:', notice);
          }
        },
      }),
    }),
    log: logDatabaseError,
  };
};

const logDatabaseError: NonNullable<KyselyConfig['log']> = (event) => {
  if (event.level === 'error') {
    if (isAssetChecksumConstraint(event.error)) {
      return;
    }

    console.error('Query failed :', {
      durationMs: event.queryDurationMillis,
      error: event.error,
      sql: event.query.sql,
      params: event.query.parameters,
    });
  }
};

export const escapeSqliteFtsQuery = (value: string) => `"${value.replaceAll('"', '""')}"`;

export const asUuid = asDatabaseUuid;

export const unnest = (array: string[]) => sql<Record<string, string>>`unnest(array[${sql.join(array)}]::text[])`;

export const removeUndefinedKeys = <T extends object>(update: T, template: unknown) => {
  for (const key in update) {
    if ((template as T)[key] === undefined) {
      delete update[key];
    }
  }

  return update;
};

export const ASSET_CHECKSUM_CONSTRAINT = 'UQ_assets_owner_checksum';
export const VIDEO_STREAM_SESSION_PK_CONSTRAINT = 'video_stream_session_pkey';

const isSqliteConstraint = (error: unknown, columns: string) => {
  const value = error as { code?: string; message?: string };
  return value?.code?.startsWith('SQLITE_CONSTRAINT') === true && value.message?.includes(columns) === true;
};

export const isAssetChecksumConstraint = (error: unknown) =>
  (error as PostgresError)?.constraint_name === ASSET_CHECKSUM_CONSTRAINT ||
  isSqliteConstraint(error, 'asset.ownerId, asset.checksum') ||
  isSqliteConstraint(error, 'asset.ownerId, asset.libraryId, asset.checksum');

export const isVideoStreamSessionPkConstraint = (error: unknown) =>
  (error as PostgresError)?.constraint_name === VIDEO_STREAM_SESSION_PK_CONSTRAINT ||
  isSqliteConstraint(error, 'video_stream_session.id');

export const isSharedLinkSlugConstraint = (error: unknown) =>
  (error as PostgresError)?.constraint_name === 'shared_link_slug_uq' || isSqliteConstraint(error, 'shared_link.slug');

export function withDefaultVisibility<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)]);
}

// TODO come up with a better query that only selects the fields we need
export function withExif<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.select((eb) =>
    jsonObjectFrom(eb.selectFrom('asset_exif').select(columns.exif).whereRef('asset_exif.assetId', '=', 'asset.id'))
      .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>> | null>()
      .as('exifInfo'),
  );
}

export function withExifInner<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb
    .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
    .select((eb) =>
      jsonObjectFrom(
        eb
          .selectFrom('asset_exif as asset_exif_json')
          .select(columns.exif.map((column) => column.replace('asset_exif.', 'asset_exif_json.')) as any)
          .whereRef('asset_exif_json.assetId', '=', 'asset.id'),
      )
        .$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>()
        .as('exifInfo'),
    )
    .$narrowType<{ exifInfo: NotNull }>();
}

export const dummy = sql`(select 1)`.as('dummy');

export function withAudioStream(eb: ExpressionBuilder<DB, 'asset_exif' | 'asset_audio'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select(['asset_audio.index', 'asset_audio.codecName', 'asset_audio.profile', 'asset_audio.bitrate'])
      .where('asset_audio.assetId', 'is not', sql.lit(null))
      .$castTo<AudioStreamInfo | null>(),
  );
}

export function withVideoStream(eb: ExpressionBuilder<DB, 'asset_exif' | 'asset_video'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select((eb) => [
        'asset_video.index',
        'asset_video.codecName',
        'asset_video.profile',
        'asset_video.level',
        'asset_video.bitrate',
        'asset_exif.exifImageWidth as width',
        'asset_exif.exifImageHeight as height',
        'asset_video.pixelFormat',
        'asset_video.frameCount',
        'asset_exif.fps as frameRate',
        'asset_video.timeBase',
        eb
          .case()
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate90CW.toString()))
          .then(sql.lit(-90))
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate270CW.toString()))
          .then(sql.lit(90))
          .when('asset_exif.orientation', '=', sql.lit(ExifOrientation.Rotate180.toString()))
          .then(sql.lit(180))
          .else(0)
          .end()
          .as('rotation'),
        'asset_video.colorPrimaries',
        'asset_video.colorMatrix',
        'asset_video.colorTransfer',
        'asset_video.dvProfile',
        'asset_video.dvLevel',
        'asset_video.dvBlSignalCompatibilityId',
      ])
      .where('asset_video.assetId', 'is not', sql.lit(null)),
  ).$castTo<(VideoStreamInfo & { timeBase: number }) | null>();
}

export function withVideoFormat(eb: ExpressionBuilder<DB, 'asset' | 'asset_video'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .select(['asset_video.formatName', 'asset_video.formatLongName', 'asset.duration', 'asset_video.bitrate'])
      .where('asset_video.assetId', 'is not', sql.lit(null)),
  ).$castTo<VideoFormat | null>();
}

export function withVideoPackets(eb: ExpressionBuilder<DB, 'asset' | 'asset_keyframe'>) {
  return jsonObjectFrom(
    eb
      .selectFrom(dummy)
      .where('asset_keyframe.assetId', 'is not', sql.lit(null))
      .select([
        'asset_keyframe.pts as keyframePts',
        'asset_keyframe.accDuration as keyframeAccDuration',
        'asset_keyframe.ownDuration as keyframeOwnDuration',
        'asset_keyframe.totalDuration',
        'asset_keyframe.packetCount',
        'asset_keyframe.outputFrames',
      ]),
  ).$castTo<VideoPacketInfo | null>();
}

export function withSmartSearch<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.leftJoin('smart_search', 'asset.id', 'smart_search.assetId').select((eb) =>
    jsonObjectFrom(
      eb
        .selectFrom('smart_search as smart_search_json')
        .select('smart_search_json.assetId')
        .select((eb) => asJsonDatabaseVector(eb.ref('smart_search_json.embedding')).as('embedding'))
        .whereRef('smart_search_json.assetId', '=', 'asset.id'),
    ).as('smartSearch'),
  );
}

const assetFaceColumns = [
  'asset_face.id',
  'asset_face.assetId',
  'asset_face.personId',
  'asset_face.imageWidth',
  'asset_face.imageHeight',
  'asset_face.boundingBoxX1',
  'asset_face.boundingBoxY1',
  'asset_face.boundingBoxX2',
  'asset_face.boundingBoxY2',
  'asset_face.sourceType',
  'asset_face.deletedAt',
  'asset_face.updatedAt',
  'asset_face.updateId',
  'asset_face.isVisible',
] as const;

const personColumns = [
  'person.id',
  'person.createdAt',
  'person.updatedAt',
  'person.ownerId',
  'person.name',
  'person.thumbnailPath',
  'person.isHidden',
  'person.birthDate',
  'person.faceAssetId',
  'person.isFavorite',
  'person.color',
  'person.updateId',
] as const;

export function withFaces(eb: ExpressionBuilder<DB, 'asset'>, withHidden?: boolean, withDeletedFace?: boolean) {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_face')
      .select(assetFaceColumns)
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .$if(!withDeletedFace, (qb) => qb.where('asset_face.deletedAt', 'is', null))
      .$if(!withHidden, (qb) => qb.where('asset_face.isVisible', '=', true)),
  ).as('faces');
}

export function withFiles(eb: ExpressionBuilder<DB, 'asset'>, type?: AssetFileType) {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_file')
      .select(columns.assetFiles)
      .whereRef('asset_file.assetId', '=', 'asset.id')
      .$if(!!type, (qb) => qb.where('asset_file.type', '=', type!)),
  ).as('files');
}

export function withFilePath(eb: ExpressionBuilder<DB, 'asset'>, type: AssetFileType, isEdited = false) {
  return eb
    .selectFrom('asset_file')
    .select('asset_file.path')
    .whereRef('asset_file.assetId', '=', 'asset.id')
    .where('asset_file.type', '=', sql.lit(type))
    .where('asset_file.isEdited', '=', sql.lit(isEdited));
}

export function withFacesAndPeople(
  eb: ExpressionBuilder<DB, 'asset'>,
  withHidden?: boolean,
  withDeletedFace?: boolean,
) {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_face')
      .select(assetFaceColumns)
      .select((eb) =>
        jsonObjectFrom(eb.selectFrom('person').select(personColumns).whereRef('asset_face.personId', '=', 'person.id'))
          .$castTo<ShallowDehydrateObject<Person> | null>()
          .as('person'),
      )
      .whereRef('asset_face.assetId', '=', 'asset.id')
      .$if(!withDeletedFace, (qb) => qb.where('asset_face.deletedAt', 'is', null))
      .$if(!withHidden, (qb) => qb.where('asset_face.isVisible', 'is', true)),
  ).as('faces');
}

export function hasPeople<O>(qb: SelectQueryBuilder<DB, 'asset', O>, personIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('asset_face')
        .select('assetId')
        .where('personId', 'in', personIds!)
        .where('deletedAt', 'is', null)
        .where('isVisible', 'is', true)
        .groupBy('assetId')
        .having((eb) => eb.fn.count('personId').distinct(), '=', personIds.length)
        .as('has_people'),
    (join) => join.onRef('has_people.assetId', '=', 'asset.id'),
  );
}

export function inAlbums<O>(qb: SelectQueryBuilder<DB, 'asset', O>, albumIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('album_asset')
        .select('assetId')
        .where('albumId', 'in', albumIds!)
        .groupBy('assetId')
        .having((eb) => eb.fn.count('albumId').distinct(), '=', albumIds.length)
        .as('has_album'),
    (join) => join.onRef('has_album.assetId', '=', 'asset.id'),
  );
}

export function hasTags<O>(qb: SelectQueryBuilder<DB, 'asset', O>, tagIds: string[]) {
  return qb.innerJoin(
    (eb) =>
      eb
        .selectFrom('tag_asset')
        .select('assetId')
        .innerJoin('tag_closure', 'tag_asset.tagId', 'tag_closure.id_descendant')
        .where('tag_closure.id_ancestor', 'in', tagIds)
        .groupBy('assetId')
        .having((eb) => eb.fn.count('tag_closure.id_ancestor').distinct(), '>=', tagIds.length)
        .as('has_tags'),
    (join) => join.onRef('has_tags.assetId', '=', 'asset.id'),
  );
}

export function withOwner(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonObjectFrom(eb.selectFrom('user').select(columns.user).whereRef('user.id', '=', 'asset.ownerId')).as(
    'owner',
  );
}

export function withLibrary(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonObjectFrom(
    eb
      .selectFrom('library')
      .select([
        'library.id',
        'library.name',
        'library.ownerId',
        'library.importPaths',
        'library.exclusionPatterns',
        'library.createdAt',
        'library.updatedAt',
        'library.deletedAt',
        'library.refreshedAt',
        'library.updateId',
      ])
      .whereRef('library.id', '=', 'asset.libraryId'),
  ).as('library');
}

export function withTags(eb: ExpressionBuilder<DB, 'asset'>) {
  return jsonArrayFrom(
    eb
      .selectFrom('tag')
      .select(columns.tag)
      .innerJoin('tag_asset', 'tag.id', 'tag_asset.tagId')
      .whereRef('asset.id', '=', 'tag_asset.assetId'),
  ).as('tags');
}

export function truncatedDate<O>(order: AssetOrderBy = AssetOrderBy.TakenAt, size?: 'DAY' | 'MONTH') {
  if (isSqliteBackend()) {
    const dateColumn = sql.ref(order === AssetOrderBy.CreatedAt ? 'asset.createdAt' : 'localDateTime');
    return size === 'DAY' ? sql<O>`substr(${dateColumn}, 1, 10)` : sql<O>`substr(${dateColumn}, 1, 7) || '-01'`;
  }
  return sql<O>`date_trunc(${sql.lit(size ?? 'MONTH')}, ${sql.ref(order === AssetOrderBy.CreatedAt ? 'asset.createdAt' : 'localDateTime')} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

export function withTagId<O>(qb: SelectQueryBuilder<DB, 'asset', O>, tagId: string) {
  return qb.where((eb) =>
    eb.exists(
      eb
        .selectFrom('tag_closure')
        .innerJoin('tag_asset', 'tag_asset.tagId', 'tag_closure.id_descendant')
        .whereRef('tag_asset.assetId', '=', 'asset.id')
        .where('tag_closure.id_ancestor', '=', tagId),
    ),
  );
}

const isCJK = (c: number): boolean =>
  (c >= 0x4e_00 && c <= 0x9f_ff) ||
  (c >= 0xac_00 && c <= 0xd7_af) ||
  (c >= 0x30_40 && c <= 0x30_9f) ||
  (c >= 0x30_a0 && c <= 0x30_ff) ||
  (c >= 0x34_00 && c <= 0x4d_bf);

export const tokenizeForSearch = (text: string): string[] => {
  /* eslint-disable unicorn/prefer-code-point */
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      i++;
      continue;
    }

    const start = i;
    if (isCJK(c)) {
      while (i < text.length && isCJK(text.charCodeAt(i))) {
        i++;
      }
      if (i - start === 1) {
        tokens.push(text[start]);
      } else {
        for (let k = start; k < i - 1; k++) {
          tokens.push(text[k] + text[k + 1]);
        }
      }
    } else {
      while (i < text.length && text.charCodeAt(i) > 32 && !isCJK(text.charCodeAt(i))) {
        i++;
      }
      tokens.push(text.slice(start, i));
    }
  }
  return tokens;
};

// needed to properly type the return with the EditActionItem discriminated union type
type AliasedEditActions = AliasedRawBuilder<AssetEditActionItem[], 'edits'>;
export function withEdits(eb: ExpressionBuilder<DB, 'asset'>): AliasedEditActions {
  return jsonArrayFrom(
    eb
      .selectFrom('asset_edit')
      .select(['asset_edit.action', 'asset_edit.parameters'])
      .whereRef('asset_edit.assetId', '=', 'asset.id'),
  ).as('edits') as AliasedEditActions;
}

const joinDeduplicationPlugin = new DeduplicateJoinsPlugin();
/** TODO: This should only be used for search-related queries, not as a general purpose query builder */

export function searchAssetBuilder(kysely: Kysely<DB>, options: AssetSearchBuilderOptions) {
  options.withDeleted ||= !!(options.trashedAfter || options.trashedBefore || options.isOffline);

  return kysely
    .withPlugin(joinDeduplicationPlugin)
    .selectFrom('asset')
    .$if(!!options.visibility, (qb) =>
      options.visibility === 'not-locked'
        ? qb.where('asset.visibility', '!=', AssetVisibility.Locked)
        : qb.where('asset.visibility', '=', options.visibility!),
    )
    .$if(!!options.albumIds && options.albumIds.length > 0, (qb) => inAlbums(qb, options.albumIds!))
    .$if(!!options.tagIds && options.tagIds.length > 0, (qb) => hasTags(qb, options.tagIds!))
    .$if(options.tagIds === null, (qb) =>
      qb.where((eb) => eb.not(eb.exists((eb) => eb.selectFrom('tag_asset').whereRef('assetId', '=', 'asset.id')))),
    )
    .$if(!!options.personIds && options.personIds.length > 0, (qb) => hasPeople(qb, options.personIds!))
    .$if(!!options.createdBefore, (qb) => qb.where('asset.createdAt', '<=', options.createdBefore!))
    .$if(!!options.createdAfter, (qb) => qb.where('asset.createdAt', '>=', options.createdAfter!))
    .$if(!!options.updatedBefore, (qb) => qb.where('asset.updatedAt', '<=', options.updatedBefore!))
    .$if(!!options.updatedAfter, (qb) => qb.where('asset.updatedAt', '>=', options.updatedAfter!))
    .$if(!!options.trashedBefore, (qb) => qb.where('asset.deletedAt', '<=', options.trashedBefore!))
    .$if(!!options.trashedAfter, (qb) => qb.where('asset.deletedAt', '>=', options.trashedAfter!))
    .$if(!!options.takenBefore, (qb) => qb.where('asset.fileCreatedAt', '<=', options.takenBefore!))
    .$if(!!options.takenAfter, (qb) => qb.where('asset.fileCreatedAt', '>=', options.takenAfter!))
    .$if(options.city !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.city', options.city === null ? 'is' : '=', options.city!),
    )
    .$if(options.state !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.state', options.state === null ? 'is' : '=', options.state!),
    )
    .$if(options.country !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.country', options.country === null ? 'is' : '=', options.country!),
    )
    .$if(options.make !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.make', options.make === null ? 'is' : '=', options.make!),
    )
    .$if(options.model !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.model', options.model === null ? 'is' : '=', options.model!),
    )
    .$if(options.lensModel !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.lensModel', options.lensModel === null ? 'is' : '=', options.lensModel!),
    )
    .$if(options.rating !== undefined, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset_exif.rating', options.rating === null ? 'is' : '=', options.rating!),
    )
    .$if(!!options.checksum, (qb) => qb.where('asset.checksum', '=', options.checksum!))
    .$if(!!options.id, (qb) => qb.where('asset.id', '=', asUuid(options.id!)))
    .$if(!!options.libraryId, (qb) => qb.where('asset.libraryId', '=', asUuid(options.libraryId!)))
    .$if(!!options.userIds, (qb) => qb.where('asset.ownerId', 'in', options.userIds!))
    .$if(!!options.encodedVideoPath, (qb) =>
      qb
        .innerJoin('asset_file', (join) =>
          join
            .onRef('asset.id', '=', 'asset_file.assetId')
            .on('asset_file.type', '=', AssetFileType.EncodedVideo)
            .on('asset_file.isEdited', '=', false),
        )
        .where('asset_file.path', '=', options.encodedVideoPath!),
    )
    .$if(!!options.originalPath, (qb) =>
      isSqliteBackend()
        ? qb.where(
            sql`immich_lower(f_unaccent(asset."originalPath"))`,
            'like',
            sql`'%' || immich_lower(f_unaccent(${options.originalPath})) || '%'`,
          )
        : qb.where(
            sql`f_unaccent(asset."originalPath")`,
            'ilike',
            sql`'%' || f_unaccent(${options.originalPath}) || '%'`,
          ),
    )
    .$if(!!options.originalFileName, (qb) =>
      isSqliteBackend()
        ? qb.where(
            sql`immich_lower(f_unaccent(asset."originalFileName"))`,
            'like',
            sql`'%' || immich_lower(f_unaccent(${options.originalFileName})) || '%'`,
          )
        : qb.where(
            sql`f_unaccent(asset."originalFileName")`,
            'ilike',
            sql`'%' || f_unaccent(${options.originalFileName}) || '%'`,
          ),
    )
    .$if(!!options.description, (qb) =>
      qb
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .$if(isSqliteBackend(), (qb) =>
          qb.where(
            sql`immich_lower(f_unaccent(asset_exif.description))`,
            'like',
            sql`'%' || immich_lower(f_unaccent(${options.description})) || '%'`,
          ),
        )
        .$if(!isSqliteBackend(), (qb) =>
          qb.where(
            sql`f_unaccent(asset_exif.description)`,
            'ilike',
            sql`'%' || f_unaccent(${options.description}) || '%'`,
          ),
        ),
    )
    .$if(!!options.ocr, (qb) =>
      qb
        .innerJoin('ocr_search', 'asset.id', 'ocr_search.assetId')
        .where(() =>
          isSqliteBackend()
            ? [...options.ocr!].length < 3
              ? sql`instr(immich_lower(f_unaccent(ocr_search.text)), immich_lower(f_unaccent(${options.ocr!}))) > 0`
              : sql`ocr_search.rowid IN (SELECT rowid FROM ocr_search_fts WHERE ocr_search_fts MATCH ${escapeSqliteFtsQuery(options.ocr!)})`
            : sql`f_unaccent(ocr_search.text) %>> f_unaccent(${tokenizeForSearch(options.ocr!).join(' ')})`,
        ),
    )
    .$if(!!options.type, (qb) => qb.where('asset.type', '=', options.type!))
    .$if(options.isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', options.isFavorite!))
    .$if(options.isOffline !== undefined, (qb) => qb.where('asset.isOffline', '=', options.isOffline!))
    .$if(options.isEncoded !== undefined, (qb) =>
      qb.where((eb) => {
        const exists = eb.exists((eb) =>
          eb
            .selectFrom('asset_file')
            .whereRef('assetId', '=', 'asset.id')
            .where('type', '=', AssetFileType.EncodedVideo),
        );
        return options.isEncoded ? exists : eb.not(exists);
      }),
    )
    .$if(options.isMotion !== undefined, (qb) =>
      qb.where('asset.livePhotoVideoId', options.isMotion ? 'is not' : 'is', null),
    )
    .$if(!!options.isNotInAlbum && (!options.albumIds || options.albumIds.length === 0), (qb) =>
      qb.where((eb) => eb.not(eb.exists((eb) => eb.selectFrom('album_asset').whereRef('assetId', '=', 'asset.id')))),
    )
    .$if(options.withStacked === false, (qb) => qb.where('asset.stackId', 'is', null))
    .$if(!!options.withExif, withExifInner)
    .$if(!!(options.withFaces || options.withPeople), (qb) => qb.select(withFacesAndPeople))
    .$if(!options.withDeleted, (qb) => qb.where('asset.deletedAt', 'is', null));
}

export type ReindexVectorIndexOptions = { indexName: string; lists?: number };

type VectorIndexQueryOptions = { table: string; vectorExtension: VectorExtension } & ReindexVectorIndexOptions;

export function vectorIndexQuery({ vectorExtension, table, indexName, lists }: VectorIndexQueryOptions): string {
  switch (vectorExtension) {
    case DatabaseExtension.VectorChord: {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
        residual_quantization = false
        [build.internal]
        lists = [${lists ?? 1}]
        spherical_centroids = true
        build_threads = 4
        sampling_factor = 1024
        $$)`;
    }
    case DatabaseExtension.Vector: {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}
        USING hnsw (embedding vector_cosine_ops)
        WITH (ef_construction = 300, m = 16)`;
    }
    default: {
      throw new Error(`Unsupported vector extension: '${vectorExtension}'`);
    }
  }
}

export const updateLockedColumns = <T extends Record<string, unknown> & { lockedProperties?: LockableProperty[] }>(
  exif: T,
) => {
  exif.lockedProperties = lockableProperties.filter((property) => property in exif);
  return exif;
};

export { asDatabaseVector as asVector } from 'src/utils/database-helpers';

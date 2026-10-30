import { Kysely } from 'kysely';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetEditAction } from 'src/dtos/editing.dto';
import { PluginManifestDto } from 'src/dtos/plugin-manifest.dto';
import { AlbumUserRole, AssetVisibility, UserMetadataKey } from 'src/enum';
import { ActivityRepository } from 'src/repositories/activity.repository';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { DuplicateRepository } from 'src/repositories/duplicate.repository';
import { MapRepository } from 'src/repositories/map.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { PluginRepository } from 'src/repositories/plugin.repository';
import { ResumableUploadRepository } from 'src/repositories/resumable-upload.repository';
import { SearchRepository } from 'src/repositories/search.repository';
import { SessionRepository } from 'src/repositories/session.repository';
import { TagRepository } from 'src/repositories/tag.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { initializeSqliteSchema } from 'src/sqlite/sqlite-schema';
import { getKyselyConfig, withSmartSearch } from 'src/utils/database';
import { mediumFactory } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

type Backend = 'postgres' | 'sqlite';

const ids = {
  user: '00000000-0000-4000-8000-000000000001',
  album: '00000000-0000-4000-8000-000000000002',
  primary: '00000000-0000-4000-8000-000000000003',
  secondary: '00000000-0000-4000-8000-000000000004',
  stack: '00000000-0000-4000-8000-000000000005',
  sessionMatch: '00000000-0000-4000-8000-000000000006',
  sessionOther: '00000000-0000-4000-8000-000000000007',
  tag: '00000000-0000-4000-8000-000000000008',
  upload: '00000000-0000-4000-8000-000000000009',
  person: '00000000-0000-4000-8000-000000000010',
  albumGuest: '00000000-0000-4000-8000-000000000011',
  createdAlbum: '00000000-0000-4000-8000-000000000012',
  createdAlbumUpdateId: '00000000-0000-7000-8000-000000000013',
  hiddenDuplicateA: '00000000-0000-4000-8000-000000000014',
  hiddenDuplicateB: '00000000-0000-4000-8000-000000000015',
  hiddenDuplicateGroup: '00000000-0000-4000-8000-000000000016',
  duplicatePersonNameA: '00000000-0000-4000-8000-000000000017',
  duplicatePersonNameB: '00000000-0000-4000-8000-000000000018',
  recognitionUser: '00000000-0000-4000-8000-000000000019',
  recognitionAsset: '00000000-0000-4000-8000-000000000020',
  recognitionFace: '00000000-0000-4000-8000-000000000021',
  smartSearchUser: '00000000-0000-4000-8000-000000000022',
  smartSearchAsset: '00000000-0000-4000-8000-000000000023',
  recognitionPerson: '00000000-0000-4000-8000-000000000024',
  recognitionAssignedFace: '00000000-0000-4000-8000-000000000025',
  recognitionMissingEmbeddingFace: '00000000-0000-4000-8000-000000000026',
  recognitionDeletedFace: '00000000-0000-4000-8000-000000000027',
};

const recognitionEmbedding = JSON.stringify(Array.from({ length: 512 }, (_, index) => (index === 0 ? 1 : 0)));
const assignedRecognitionEmbedding = JSON.stringify(Array.from({ length: 512 }, (_, index) => (index === 1 ? 1 : 0)));
const deletedRecognitionEmbedding = JSON.stringify(Array.from({ length: 512 }, (_, index) => (index === 2 ? 1 : 0)));

const auditIds = {
  cascadeUser: '00000000-0000-4000-8000-000000000100',
  otherUser: '00000000-0000-4000-8000-000000000101',
  cascadeAsset: '00000000-0000-4000-8000-000000000102',
  cascadeMemory: '00000000-0000-4000-8000-000000000103',
  cascadePerson: '00000000-0000-4000-8000-000000000104',
  assetOwner: '00000000-0000-4000-8000-000000000110',
  deletedAsset: '00000000-0000-4000-8000-000000000111',
  assetPerson: '00000000-0000-4000-8000-000000000112',
  assetFace: '00000000-0000-4000-8000-000000000113',
  assetEdit: '00000000-0000-4000-8000-000000000114',
  assetOcr: '00000000-0000-4000-8000-000000000115',
  directAsset: '00000000-0000-4000-8000-000000000120',
  directFace: '00000000-0000-4000-8000-000000000121',
  directEdit: '00000000-0000-4000-8000-000000000122',
  directOcr: '00000000-0000-4000-8000-000000000123',
  album: '00000000-0000-4000-8000-000000000130',
  albumAsset: '00000000-0000-4000-8000-000000000131',
  directAlbum: '00000000-0000-4000-8000-000000000132',
  directAlbumAsset: '00000000-0000-4000-8000-000000000133',
};

const selectAuditRows = async <T extends keyof DB>(database: Kysely<DB>, table: T, columns: (keyof DB[T])[]) =>
  database
    .selectFrom(database.dynamic.table(table).as('audit'))
    .select(columns.map((column) => database.dynamic.ref(String(column))))
    .orderBy(database.dynamic.ref(String(columns[0])))
    .execute();

const auditOcrRow = (id: string, assetId: string) => ({
  id,
  assetId,
  x1: 0,
  y1: 0,
  x2: 1,
  y2: 0,
  x3: 1,
  y3: 1,
  x4: 0,
  y4: 1,
  boxScore: 1,
  textScore: 1,
  text: 'audit',
});

const parsePluginMethods = (methods: Array<Record<string, unknown>>) =>
  PluginManifestDto.schema.parse({
    name: 'repository-contract-plugin',
    version: '1.0.0',
    title: 'Repository contract plugin',
    description: 'Exercises plugin method persistence',
    wasmPath: 'plugin.wasm',
    author: 'Immich',
    methods,
  }).methods;

const runAuditTriggerContract = async (database: Kysely<DB>, backend: Backend) => {
  process.env.DB_BACKEND = backend;
  await database
    .insertInto('user')
    .values([
      mediumFactory.userInsert({ id: auditIds.cascadeUser }),
      mediumFactory.userInsert({ id: auditIds.otherUser }),
      mediumFactory.userInsert({ id: auditIds.assetOwner }),
    ])
    .execute();

  await database
    .insertInto('asset')
    .values(
      mediumFactory.assetInsert({
        id: auditIds.cascadeAsset,
        ownerId: auditIds.cascadeUser,
        originalPath: '/audit/user-cascade.jpg',
      }),
    )
    .execute();
  await database
    .insertInto('memory')
    .values(mediumFactory.memoryInsert({ id: auditIds.cascadeMemory, ownerId: auditIds.cascadeUser }))
    .execute();
  await database
    .insertInto('person')
    .values(mediumFactory.personInsert({ id: auditIds.cascadePerson, ownerId: auditIds.cascadeUser }))
    .execute();
  await database
    .insertInto('user_metadata')
    .values({
      userId: auditIds.cascadeUser,
      key: UserMetadataKey.Onboarding,
      value: { isOnboarded: true },
    })
    .execute();
  await database
    .insertInto('partner')
    .values({ sharedById: auditIds.cascadeUser, sharedWithId: auditIds.otherUser })
    .execute();
  await database.deleteFrom('user').where('id', '=', auditIds.cascadeUser).execute();

  await database
    .insertInto('asset')
    .values([
      mediumFactory.assetInsert({
        id: auditIds.deletedAsset,
        ownerId: auditIds.assetOwner,
        originalPath: '/audit/asset-cascade.jpg',
      }),
      mediumFactory.assetInsert({
        id: auditIds.directAsset,
        ownerId: auditIds.assetOwner,
        originalPath: '/audit/direct-child.jpg',
      }),
      mediumFactory.assetInsert({
        id: auditIds.albumAsset,
        ownerId: auditIds.assetOwner,
        originalPath: '/audit/album-cascade.jpg',
      }),
      mediumFactory.assetInsert({
        id: auditIds.directAlbumAsset,
        ownerId: auditIds.assetOwner,
        originalPath: '/audit/direct-album.jpg',
      }),
    ])
    .execute();
  await database
    .insertInto('person')
    .values(mediumFactory.personInsert({ id: auditIds.assetPerson, ownerId: auditIds.assetOwner }))
    .execute();
  await database
    .insertInto('asset_metadata')
    .values([
      { assetId: auditIds.deletedAsset, key: 'audit-cascade', value: {} },
      { assetId: auditIds.directAsset, key: 'audit-direct', value: {} },
    ])
    .execute();
  await database
    .insertInto('asset_face')
    .values([
      mediumFactory.assetFaceInsert({
        id: auditIds.assetFace,
        assetId: auditIds.deletedAsset,
        personId: auditIds.assetPerson,
      }),
      mediumFactory.assetFaceInsert({
        id: auditIds.directFace,
        assetId: auditIds.directAsset,
        personId: auditIds.assetPerson,
      }),
    ])
    .execute();
  await database
    .insertInto('asset_edit')
    .values([
      {
        id: auditIds.assetEdit,
        assetId: auditIds.deletedAsset,
        action: AssetEditAction.Rotate,
        parameters: { angle: 90 },
        sequence: 0,
      },
      {
        id: auditIds.directEdit,
        assetId: auditIds.directAsset,
        action: AssetEditAction.Rotate,
        parameters: { angle: 90 },
        sequence: 0,
      },
    ])
    .execute();
  await database
    .insertInto('asset_ocr')
    .values([
      auditOcrRow(auditIds.assetOcr, auditIds.deletedAsset),
      auditOcrRow(auditIds.directOcr, auditIds.directAsset),
    ])
    .execute();

  await database.deleteFrom('asset').where('id', '=', auditIds.deletedAsset).execute();
  await database.deleteFrom('asset_metadata').where('assetId', '=', auditIds.directAsset).execute();
  await database.deleteFrom('asset_face').where('assetId', '=', auditIds.directAsset).execute();
  await database.deleteFrom('asset_edit').where('assetId', '=', auditIds.directAsset).execute();
  await database.deleteFrom('asset_ocr').where('assetId', '=', auditIds.directAsset).execute();

  await database
    .insertInto('album')
    .values([
      mediumFactory.albumInsert({ id: auditIds.album }),
      mediumFactory.albumInsert({ id: auditIds.directAlbum }),
    ])
    .execute();
  await database
    .insertInto('album_user')
    .values([
      { albumId: auditIds.album, userId: auditIds.assetOwner, role: AlbumUserRole.Owner },
      { albumId: auditIds.directAlbum, userId: auditIds.assetOwner, role: AlbumUserRole.Owner },
    ])
    .execute();
  await database
    .insertInto('album_asset')
    .values([
      { albumId: auditIds.album, assetId: auditIds.albumAsset },
      { albumId: auditIds.directAlbum, assetId: auditIds.directAlbumAsset },
    ])
    .execute();
  await database.deleteFrom('album').where('id', '=', auditIds.album).execute();
  await database
    .deleteFrom('album_asset')
    .where('albumId', '=', auditIds.directAlbum)
    .where('assetId', '=', auditIds.directAlbumAsset)
    .execute();
  await database
    .deleteFrom('album_user')
    .where('albumId', '=', auditIds.directAlbum)
    .where('userId', '=', auditIds.assetOwner)
    .execute();

  return {
    user: await selectAuditRows(database, 'user_audit', ['userId']),
    partner: await selectAuditRows(database, 'partner_audit', ['sharedById', 'sharedWithId']),
    asset: await selectAuditRows(database, 'asset_audit', ['assetId', 'ownerId']),
    memory: await selectAuditRows(database, 'memory_audit', ['memoryId', 'userId']),
    person: await selectAuditRows(database, 'person_audit', ['personId', 'ownerId']),
    userMetadata: await selectAuditRows(database, 'user_metadata_audit', ['userId', 'key']),
    assetMetadata: await selectAuditRows(database, 'asset_metadata_audit', ['assetId', 'key']),
    assetFace: await selectAuditRows(database, 'asset_face_audit', ['assetFaceId', 'assetId']),
    assetEdit: await selectAuditRows(database, 'asset_edit_audit', ['editId', 'assetId']),
    assetOcr: await selectAuditRows(database, 'asset_ocr_audit', ['assetId']),
    album: await selectAuditRows(database, 'album_audit', ['albumId', 'userId']),
    albumUser: await selectAuditRows(database, 'album_user_audit', ['albumId', 'userId']),
    albumAsset: await selectAuditRows(database, 'album_asset_audit', ['albumId', 'assetId']),
  };
};

const runRepositoryContract = async (database: Kysely<DB>, backend: Backend) => {
  process.env.DB_BACKEND = backend;
  const originalDate = new Date('2026-07-19T08:05:00.000Z');
  await database
    .insertInto('user')
    .values([
      mediumFactory.userInsert({ id: ids.user, oauthId: 'subject-1' }),
      mediumFactory.userInsert({ id: ids.albumGuest }),
    ])
    .execute();
  await database
    .insertInto('album')
    .values({ id: ids.album, albumName: '["trip"]', description: '{"note":"plain text"}' })
    .execute();
  await database
    .insertInto('asset')
    .values([
      mediumFactory.assetInsert({
        id: ids.primary,
        ownerId: ids.user,
        originalPath: '/contract/primary.jpg',
        originalFileName: 'MiXeD-Ä.JPG',
        fileCreatedAt: originalDate,
        fileModifiedAt: originalDate,
        localDateTime: originalDate,
      }),
      mediumFactory.assetInsert({
        id: ids.secondary,
        ownerId: ids.user,
        originalPath: '/contract/secondary.jpg',
        originalFileName: 'secondary.jpg',
        fileCreatedAt: originalDate,
        fileModifiedAt: originalDate,
        localDateTime: originalDate,
      }),
      mediumFactory.assetInsert({
        id: ids.hiddenDuplicateA,
        ownerId: ids.user,
        originalPath: '/contract/hidden-duplicate-a.jpg',
        visibility: AssetVisibility.Hidden,
        duplicateId: ids.hiddenDuplicateGroup,
      }),
      mediumFactory.assetInsert({
        id: ids.hiddenDuplicateB,
        ownerId: ids.user,
        originalPath: '/contract/hidden-duplicate-b.jpg',
        visibility: AssetVisibility.Hidden,
        duplicateId: ids.hiddenDuplicateGroup,
      }),
    ])
    .execute();
  await database
    .insertInto('person')
    .values([
      mediumFactory.personInsert({ id: ids.person, ownerId: ids.user, name: 'MiXeD-Älice' }),
      mediumFactory.personInsert({ id: ids.duplicatePersonNameA, ownerId: ids.user, name: 'Case-Ørn' }),
      mediumFactory.personInsert({ id: ids.duplicatePersonNameB, ownerId: ids.user, name: 'case-ørn' }),
    ])
    .execute();
  await database
    .insertInto('stack')
    .values({ id: ids.stack, ownerId: ids.user, primaryAssetId: ids.primary })
    .execute();
  await database
    .updateTable('asset')
    .set({ stackId: ids.stack })
    .where('id', 'in', [ids.primary, ids.secondary])
    .execute();
  await database.insertInto('album_asset').values({ albumId: ids.album, assetId: ids.primary }).execute();
  await database
    .insertInto('activity')
    .values({ albumId: ids.album, assetId: ids.primary, userId: ids.user, comment: 'hello', isLiked: false })
    .execute();
  await database
    .insertInto('asset_exif')
    .values({ assetId: ids.primary, dateTimeOriginal: originalDate, lockedProperties: ['dateTimeOriginal'] })
    .execute();
  await database.insertInto('ocr_search').values({ assetId: ids.primary, text: '你好 hello OR world' }).execute();
  await database
    .insertInto('asset_metadata')
    .values({
      assetId: ids.primary,
      key: 'contract',
      value: { nested: ['json'], when: originalDate.toISOString(), enabled: 1 },
    })
    .execute();
  await database.insertInto('tag').values({ id: ids.tag, userId: ids.user, value: '{"tag":"plain text"}' }).execute();
  await database
    .insertInto('geodata_places')
    .values({
      id: 1,
      name: 'München',
      longitude: 11.576,
      latitude: 48.137,
      countryCode: 'DE',
      admin1Code: null,
      admin2Code: null,
      modificationDate: new Date('2026-07-19T00:00:00.000Z'),
      admin1Name: 'Bayern',
      admin2Name: null,
      alternateNames: 'Munich',
    })
    .execute();
  await database
    .insertInto('geodata_alternate_names')
    .values([
      {
        id: 1,
        geonameId: 1,
        isolanguage: 'zh-CN',
        name: '慕尼黑',
        isPreferredName: true,
        isShortName: false,
        isColloquial: false,
        isHistoric: false,
        validFrom: null,
        validTo: null,
      },
      {
        id: 2,
        geonameId: 1,
        isolanguage: 'en',
        name: 'Munich',
        isPreferredName: true,
        isShortName: false,
        isColloquial: false,
        isHistoric: false,
        validFrom: null,
        validTo: null,
      },
      {
        id: 3,
        geonameId: 1_816_670,
        isolanguage: 'zh-CN',
        name: '北京',
        isPreferredName: true,
        isShortName: false,
        isColloquial: false,
        isHistoric: false,
        validFrom: null,
        validTo: null,
      },
      {
        id: 4,
        geonameId: 2_038_349,
        isolanguage: 'zh-CN',
        name: '北京市',
        isPreferredName: true,
        isShortName: false,
        isColloquial: false,
        isHistoric: false,
        validFrom: null,
        validTo: null,
      },
    ])
    .execute();
  await database
    .insertInto('geodata_places')
    .values({
      id: 2,
      name: 'Łódź',
      longitude: 19.456,
      latitude: 51.759,
      countryCode: 'PL',
      admin1Code: null,
      admin2Code: null,
      modificationDate: new Date('2026-07-19T00:00:00.000Z'),
      admin1Name: null,
      admin2Name: null,
      alternateNames: '',
    })
    .execute();
  await database
    .insertInto('geodata_places')
    .values({
      id: 1_816_670,
      name: 'Beijing',
      longitude: 116.4074,
      latitude: 39.9042,
      countryCode: 'CN',
      admin1Code: '22',
      admin2Code: null,
      modificationDate: new Date('2026-07-19T00:00:00.000Z'),
      admin1Id: 2_038_349,
      admin1Name: 'Beijing',
      admin2Name: null,
      alternateNames: 'Peking',
    })
    .execute();
  await database
    .insertInto('naturalearth_countries')
    .values({
      admin: 'China',
      admin_a3: 'CHN',
      type: 'Country',
      coordinates: '((79,29),(81,29),(81,31),(79,31),(79,29))',
    })
    .execute();
  await database
    .insertInto('session')
    .values([
      mediumFactory.sessionInsert({ id: ids.sessionMatch, userId: ids.user, oauthSid: 'sid-1' }),
      mediumFactory.sessionInsert({ id: ids.sessionOther, userId: ids.user, oauthSid: 'sid-2' }),
    ])
    .execute();

  const activities = await new ActivityRepository(database).search({ albumId: ids.album });
  const createdAlbumDate = new Date('2026-07-19T08:00:00.000Z');
  await new AlbumRepository(database).create(
    mediumFactory.albumInsert({
      id: ids.createdAlbum,
      albumName: 'Trigger contract',
      createdAt: createdAlbumDate,
      updatedAt: createdAlbumDate,
      updateId: ids.createdAlbumUpdateId,
    }),
    [],
    [
      { userId: ids.user, role: AlbumUserRole.Owner },
      { userId: ids.albumGuest, role: AlbumUserRole.Editor },
    ],
    ids.user,
  );
  const createdAlbum = await database
    .selectFrom('album')
    .select(['updatedAt', 'updateId'])
    .where('id', '=', ids.createdAlbum)
    .executeTakeFirstOrThrow();
  const albumBeforeShare = await database
    .selectFrom('album')
    .select('updateId')
    .where('id', '=', ids.album)
    .executeTakeFirstOrThrow();
  await new AlbumUserRepository(database).create({
    albumId: ids.album,
    userId: ids.albumGuest,
    role: AlbumUserRole.Editor,
  });
  const albumAfterShare = await database
    .selectFrom('album')
    .select('updateId')
    .where('id', '=', ids.album)
    .executeTakeFirstOrThrow();
  const deletion = await new AssetJobRepository(database).getForAssetDeletion(ids.primary);
  const assets = new AssetRepository(database);
  const upsertedTag = await new TagRepository(database, { setContext: vi.fn() } as never).upsertValue({
    userId: ids.user,
    value: '{"tag":"plain text"}',
  });
  const storedTag = await database
    .selectFrom('tag')
    .select('updatedAt')
    .where('id', '=', ids.tag)
    .executeTakeFirstOrThrow();
  const timeBuckets = await assets.getTimeBuckets({ userIds: [ids.user], withStacked: true });
  const duplicateGroups = await new DuplicateRepository(database).getAll(ids.user);
  const updatedDates = await assets.updateDateTimeOriginal([ids.primary], 60, 'UTC');
  const [returnedMetadata] = await assets.upsertMetadata(ids.primary, [
    { key: 'contract', value: { nested: ['json'], when: originalDate.toISOString(), enabled: 1 } },
  ]);
  const storedMetadata = await database
    .selectFrom('asset_metadata')
    .select('updatedAt')
    .where('assetId', '=', ids.primary)
    .where('key', '=', 'contract')
    .executeTakeFirstOrThrow();
  const metadata = await assets.getMetadata(ids.primary);
  const albumMetadataRows = await new AlbumRepository(database).getMetadataForIds([ids.album]);
  const albumMetadata = albumMetadataRows[0];
  const resumableUploads = new ResumableUploadRepository(database);
  const upload = await resumableUploads.create({
    id: ids.upload,
    ownerId: ids.user,
    filename: 'chunked.jpg',
    fileSize: 5,
    checksum: Buffer.from('upload-checksum'),
    offset: 0,
    tempPath: '/tmp/chunked.jpg.part',
    metadata: { source: 'contract' },
    expiresAt: new Date('2026-07-20T08:05:00.000Z'),
  });
  const appendedUpload = await resumableUploads.append(ids.upload, ids.user, 0, () => Promise.resolve(5));
  const search = await new SearchRepository(database).searchMetadata(
    { page: 1, size: 10 },
    { ocr: 'hello OR', userIds: [ids.user] },
  );
  const shortOcrSearch = await new SearchRepository(database).searchMetadata(
    { page: 1, size: 10 },
    { ocr: '你好', userIds: [ids.user] },
  );
  const filenameSearch = await new SearchRepository(database).searchMetadata(
    { page: 1, size: 10 },
    { originalFileName: 'mixed-ä.jpg', userIds: [ids.user] },
  );
  const places = await new SearchRepository(database).searchPlaces('mÜNCHEN');
  const expandedUnaccentPlaces = await new SearchRepository(database).searchPlaces('lodz');
  const localizedPlace = await new MapRepository(
    { getEnv: () => ({ reverseGeocoding: { language: 'zh-CN' } }) } as never,
    {} as never,
    { setContext: vi.fn(), debug: vi.fn(), verboseFn: vi.fn(), log: vi.fn() } as never,
    database as never,
  ).reverseGeocode({ latitude: 48.137, longitude: 11.576 });
  const localizedChina = await new MapRepository(
    { getEnv: () => ({ reverseGeocoding: { language: 'zh-CN' } }) } as never,
    {} as never,
    { setContext: vi.fn(), debug: vi.fn(), verboseFn: vi.fn(), log: vi.fn() } as never,
    database as never,
  ).reverseGeocode({ latitude: 39.9042, longitude: 116.4074 });
  const localizedEnglish = await new MapRepository(
    { getEnv: () => ({ reverseGeocoding: { language: 'en' } }) } as never,
    {} as never,
    { setContext: vi.fn(), debug: vi.fn(), verboseFn: vi.fn(), log: vi.fn() } as never,
    database as never,
  ).reverseGeocode({ latitude: 48.137, longitude: 11.576 });
  const localizedCountryBoundary = await new MapRepository(
    { getEnv: () => ({ reverseGeocoding: { language: 'zh-CN' } }) } as never,
    {} as never,
    { setContext: vi.fn(), debug: vi.fn(), verboseFn: vi.fn(), log: vi.fn() } as never,
    database as never,
  ).reverseGeocode({ latitude: 30, longitude: 80 });
  const people = await new PersonRepository(database).getByName(ids.user, 'mixed-äLICE', { withHidden: true });
  const distinctPersonNames = await new PersonRepository(database).getDistinctNames(ids.user, { withHidden: true });
  const sessions = new SessionRepository(database);
  const sessionBeforeUpdate = await database
    .selectFrom('session')
    .select('updateId')
    .where('id', '=', ids.sessionMatch)
    .executeTakeFirstOrThrow();
  const returnedSession = await sessions.update(ids.sessionMatch, { appVersion: '1.2.3' });
  const storedSession = await database
    .selectFrom('session')
    .select(['updatedAt', 'updateId'])
    .where('id', '=', ids.sessionMatch)
    .executeTakeFirstOrThrow();
  const invalidatedWithSid = await sessions.invalidateOAuth({ oauthId: 'subject-1', oauthSid: 'sid-1' });
  const invalidatedBySubject = await sessions.invalidateOAuth({ oauthId: 'subject-1' });
  const userBeforeUsage = await database
    .selectFrom('user')
    .select('updateId')
    .where('id', '=', ids.user)
    .executeTakeFirstOrThrow();
  await new UserRepository(database).updateUsage(ids.user, 1);
  const userAfterUsage = await database
    .selectFrom('user')
    .select('updateId')
    .where('id', '=', ids.user)
    .executeTakeFirstOrThrow();
  const album = await database
    .selectFrom('album')
    .select(['albumName', 'description'])
    .where('id', '=', ids.album)
    .executeTakeFirstOrThrow();
  const tag = await database.selectFrom('tag').select('value').where('id', '=', ids.tag).executeTakeFirstOrThrow();

  return {
    activity: activities.map(({ comment, isLiked, user }) => ({
      comment,
      isLiked,
      user: { id: user.id, name: user.name },
    })),
    album,
    albumMetadata: {
      albumId: albumMetadata?.albumId,
      assetCount: albumMetadata?.assetCount,
      startDate: albumMetadata?.startDate?.toISOString(),
      endDate: albumMetadata?.endDate?.toISOString(),
    },
    createdAlbum: {
      updatedAt: createdAlbum.updatedAt.toISOString(),
      updateId: createdAlbum.updateId,
    },
    albumShareUpdateIdChanged: albumAfterShare.updateId !== albumBeforeShare.updateId,
    deletion: {
      exifLockedProperties: deletion?.exifInfo?.lockedProperties,
      stack: deletion?.stack,
    },
    duplicateGroupIds: duplicateGroups.map(({ duplicateId }) => duplicateId).sort(),
    invalidatedBySubject: invalidatedBySubject.sort(),
    invalidatedWithSid: invalidatedWithSid.sort(),
    returnedSyncCursorMatchesStored:
      returnedSession.updateId === storedSession.updateId &&
      returnedSession.updatedAt.getTime() === storedSession.updatedAt.getTime(),
    returnedSyncCursorChanged: returnedSession.updateId !== sessionBeforeUpdate.updateId,
    usageUpdateIdChanged: userAfterUsage.updateId !== userBeforeUsage.updateId,
    returnedUpsertTimestampMatchesStored: returnedMetadata.updatedAt.getTime() === storedMetadata.updatedAt.getTime(),
    metadata: metadata.map(({ key, value }) => ({ key, value })),
    ocrAssetIds: search.items.map(({ id }) => id).sort(),
    shortOcrAssetIds: shortOcrSearch.items.map(({ id }) => id).sort(),
    filenameAssetIds: filenameSearch.items.map(({ id }) => id).sort(),
    personIds: people.map(({ id }) => id).sort(),
    distinctPersonNameCount: distinctPersonNames.length,
    placeIds: places.map(({ id }) => id),
    expandedUnaccentPlaceIds: expandedUnaccentPlaces.map(({ id }) => id),
    localizedPlace,
    localizedChina,
    localizedEnglish,
    localizedCountryBoundary,
    tag,
    returnedTagTimestampMatchesStored: upsertedTag.updatedAt.getTime() === storedTag.updatedAt.getTime(),
    timeBuckets,
    resumableUpload: {
      offset: Number(appendedUpload?.session.offset),
      updateIdChanged: appendedUpload?.session.updateId !== upload.updateId,
      updatedAtIsDate: appendedUpload?.session.updatedAt instanceof Date,
    },
    updatedDates: updatedDates.map(({ assetId, dateTimeOriginal, timeZone }) => ({
      assetId,
      dateTimeOriginal: dateTimeOriginal?.toISOString(),
      timeZone,
    })),
  };
};

const runPluginRepositoryContract = async (database: Kysely<DB>, backend: Backend) => {
  process.env.DB_BACKEND = backend;
  const pluginRepository = new PluginRepository(database, { setContext: vi.fn() } as never);
  const method = {
    title: 'Contract method',
    description: 'Contract method description',
    types: ['AssetV1'],
  };

  await pluginRepository.upsert(
    {
      name: 'repository-contract-plugin',
      version: '1.0.0',
      title: 'Repository contract plugin',
      description: 'Exercises plugin method persistence',
      author: 'Immich',
      wasmBytes: Buffer.from('contract-wasm'),
      templates: [],
      sha256hash: Buffer.from('contract-sha256'),
    },
    parsePluginMethods([
      { ...method, name: 'missingHints' },
      { ...method, name: 'emptyHints', uiHints: [] },
      { ...method, name: 'configuredHints', uiHints: ['filter'] },
    ]),
  );

  await pluginRepository.upsert(
    {
      name: 'repository-contract-plugin',
      version: '1.0.0',
      title: 'Updated repository contract plugin',
      description: 'Exercises repeated plugin method persistence',
      author: 'Immich',
      wasmBytes: Buffer.from('updated-contract-wasm'),
      templates: [],
      sha256hash: Buffer.from('updated-contract-sha256'),
    },
    parsePluginMethods([
      { ...method, name: 'missingHints' },
      { ...method, name: 'configuredHints', uiHints: ['filter', 'updated'] },
    ]),
  );

  const methods = await pluginRepository.searchMethods({ pluginName: 'repository-contract-plugin' });
  return methods.map(({ name, uiHints }) => ({ name, uiHints }));
};

const runFacialRecognitionRepositoryContract = async (database: Kysely<DB>, backend: Backend) => {
  process.env.DB_BACKEND = backend;
  await database
    .insertInto('user')
    .values(mediumFactory.userInsert({ id: ids.recognitionUser }))
    .execute();
  await database
    .insertInto('asset')
    .values(
      mediumFactory.assetInsert({
        id: ids.recognitionAsset,
        ownerId: ids.recognitionUser,
        originalPath: '/contract/recognition.jpg',
      }),
    )
    .execute();
  await database
    .insertInto('person')
    .values(mediumFactory.personInsert({ id: ids.recognitionPerson, ownerId: ids.recognitionUser }))
    .execute();

  const people = new PersonRepository(database);
  await people.refreshFaces(
    [
      mediumFactory.assetFaceInsert({
        id: ids.recognitionFace,
        assetId: ids.recognitionAsset,
      }),
      mediumFactory.assetFaceInsert({
        id: ids.recognitionAssignedFace,
        assetId: ids.recognitionAsset,
        personId: ids.recognitionPerson,
      }),
      mediumFactory.assetFaceInsert({
        id: ids.recognitionMissingEmbeddingFace,
        assetId: ids.recognitionAsset,
      }),
      mediumFactory.assetFaceInsert({
        id: ids.recognitionDeletedFace,
        assetId: ids.recognitionAsset,
        deletedAt: new Date('2026-07-19T08:00:00.000Z'),
      }),
    ],
    [],
    [
      { faceId: ids.recognitionFace, embedding: recognitionEmbedding },
      { faceId: ids.recognitionAssignedFace, embedding: assignedRecognitionEmbedding },
      { faceId: ids.recognitionDeletedFace, embedding: deletedRecognitionEmbedding },
    ],
  );

  const face = await people.getFaceForFacialRecognitionJob(ids.recognitionFace);
  const assignedFace = await people.getFaceForFacialRecognitionJob(ids.recognitionAssignedFace);
  const missingEmbeddingFace = await people.getFaceForFacialRecognitionJob(ids.recognitionMissingEmbeddingFace);
  const deletedFace = await people.getFaceForFacialRecognitionJob(ids.recognitionDeletedFace);
  const matches = await new SearchRepository(database).searchFaces({
    userIds: [ids.recognitionUser],
    embedding: recognitionEmbedding,
    numResults: 10,
    maxDistance: 0.01,
  });

  return {
    face: {
      id: face?.id,
      personId: face?.personId,
      sourceType: face?.sourceType,
      asset: face?.asset && {
        ownerId: face.asset.ownerId,
        visibility: face.asset.visibility,
      },
      faceSearch: face?.faceSearch && {
        faceId: face.faceSearch.faceId,
        embedding: JSON.parse(face.faceSearch.embedding),
      },
    },
    assignedFace: {
      id: assignedFace?.id,
      personId: assignedFace?.personId,
      faceSearch: assignedFace?.faceSearch && {
        faceId: assignedFace.faceSearch.faceId,
        embedding: JSON.parse(assignedFace.faceSearch.embedding),
      },
    },
    missingEmbeddingFace: {
      id: missingEmbeddingFace?.id,
      personId: missingEmbeddingFace?.personId,
      faceSearch: missingEmbeddingFace?.faceSearch,
    },
    deletedFace,
    matchedFaceIds: matches.map(({ id }) => id),
  };
};

const runSmartSearchJsonContract = async (database: Kysely<DB>, backend: Backend) => {
  process.env.DB_BACKEND = backend;
  await database
    .insertInto('user')
    .values(mediumFactory.userInsert({ id: ids.smartSearchUser }))
    .execute();
  await database
    .insertInto('asset')
    .values(
      mediumFactory.assetInsert({
        id: ids.smartSearchAsset,
        ownerId: ids.smartSearchUser,
        originalPath: '/contract/smart-search.jpg',
      }),
    )
    .execute();
  await new SearchRepository(database).upsert(ids.smartSearchAsset, recognitionEmbedding);

  const result = await database
    .selectFrom('asset')
    .select('asset.id')
    .$call(withSmartSearch)
    .where('asset.id', '=', ids.smartSearchAsset)
    .executeTakeFirstOrThrow();

  return {
    assetId: result.id,
    smartSearch: result.smartSearch && {
      assetId: result.smartSearch.assetId,
      embedding: JSON.parse(result.smartSearch.embedding),
    },
  };
};

describe('PostgreSQL/SQLite repository conformance', () => {
  let postgres: Kysely<DB>;
  let sqlite: Kysely<DB>;
  let sqliteFolder: string;
  const previousBackend = process.env.DB_BACKEND;

  beforeAll(async () => {
    postgres = await getKyselyDB('backend_conformance');
    sqliteFolder = await mkdtemp(join(tmpdir(), 'immich-backend-conformance-'));
    sqlite = new Kysely<DB>(getKyselyConfig({ backend: 'sqlite', path: join(sqliteFolder, 'immich.sqlite') }));
    process.env.DB_BACKEND = 'sqlite';
    await initializeSqliteSchema(sqlite);
  });

  afterAll(async () => {
    await postgres.destroy();
    await sqlite.destroy();
    await rm(sqliteFolder, { recursive: true, force: true });
    process.env.DB_BACKEND = previousBackend;
  });

  it('returns the same repository results and mutation behavior', async () => {
    const postgresResult = await runRepositoryContract(postgres, 'postgres');
    const sqliteResult = await runRepositoryContract(sqlite, 'sqlite');

    expect(sqliteResult).toEqual(postgresResult);
    expect(sqliteResult).toMatchObject({
      album: { albumName: '["trip"]', description: '{"note":"plain text"}' },
      albumMetadata: {
        albumId: ids.album,
        assetCount: 1,
        startDate: '2026-07-19T00:00:00.000Z',
        endDate: '2026-07-19T00:00:00.000Z',
      },
      createdAlbum: {
        updatedAt: '2026-07-19T08:00:00.000Z',
        updateId: ids.createdAlbumUpdateId,
      },
      albumShareUpdateIdChanged: true,
      deletion: {
        exifLockedProperties: ['dateTimeOriginal'],
        stack: { id: ids.stack, primaryAssetId: ids.primary, assets: [{ id: ids.secondary }] },
      },
      duplicateGroupIds: [],
      invalidatedBySubject: [ids.sessionOther],
      invalidatedWithSid: [ids.sessionMatch],
      returnedSyncCursorMatchesStored: true,
      returnedSyncCursorChanged: true,
      usageUpdateIdChanged: true,
      returnedUpsertTimestampMatchesStored: true,
      metadata: [
        {
          key: 'contract',
          value: { nested: ['json'], when: '2026-07-19T08:05:00.000Z', enabled: 1 },
        },
      ],
      ocrAssetIds: [ids.primary],
      shortOcrAssetIds: [ids.primary],
      filenameAssetIds: [ids.primary],
      personIds: [ids.person],
      distinctPersonNameCount: 2,
      placeIds: [1],
      expandedUnaccentPlaceIds: [2],
      localizedPlace: { city: '慕尼黑', state: 'Bayern', country: '德国' },
      localizedChina: { city: '北京', state: '北京市', country: '中国' },
      localizedEnglish: { city: 'Munich', state: 'Bayern', country: 'Germany' },
      localizedCountryBoundary: { city: null, state: null, country: '中国' },
      tag: { value: '{"tag":"plain text"}' },
      returnedTagTimestampMatchesStored: true,
      timeBuckets: [{ count: 1, timeBucket: '2026-07-01' }],
      resumableUpload: { offset: 5, updateIdChanged: true, updatedAtIsDate: true },
      updatedDates: [{ assetId: ids.primary, dateTimeOriginal: '2026-07-19T09:05:00.000Z', timeZone: 'UTC' }],
    });
  });

  it('matches direct-delete and cascade audit trigger behavior', async () => {
    const postgresResult = await runAuditTriggerContract(postgres, 'postgres');
    const sqliteResult = await runAuditTriggerContract(sqlite, 'sqlite');

    expect(sqliteResult).toEqual(postgresResult);
    expect(sqliteResult).toMatchObject({
      user: [{ userId: auditIds.cascadeUser }],
      partner: [],
      asset: [{ assetId: auditIds.deletedAsset, ownerId: auditIds.assetOwner }],
      memory: [],
      person: [],
      userMetadata: [],
      assetMetadata: [{ assetId: auditIds.directAsset, key: 'audit-direct' }],
      assetFace: [{ assetFaceId: auditIds.directFace, assetId: auditIds.directAsset }],
      assetEdit: [{ editId: auditIds.directEdit, assetId: auditIds.directAsset }],
      assetOcr: [{ assetId: auditIds.directAsset }],
      album: [
        { albumId: auditIds.album, userId: auditIds.assetOwner },
        { albumId: auditIds.directAlbum, userId: auditIds.assetOwner },
      ],
      albumUser: [
        { albumId: auditIds.album, userId: auditIds.assetOwner },
        { albumId: auditIds.directAlbum, userId: auditIds.assetOwner },
      ],
      albumAsset: [{ albumId: auditIds.directAlbum, assetId: auditIds.directAlbumAsset }],
    });
  });

  it('matches plugin method defaults, updates, and pruning', async () => {
    const postgresResult = await runPluginRepositoryContract(postgres, 'postgres');
    const sqliteResult = await runPluginRepositoryContract(sqlite, 'sqlite');

    expect(sqliteResult).toEqual(postgresResult);
    expect(sqliteResult).toEqual([
      { name: 'configuredHints', uiHints: ['filter', 'updated'] },
      { name: 'missingHints', uiHints: [] },
    ]);
  });

  it('returns JSON-safe face embeddings that remain usable for similarity search', async () => {
    const postgresResult = await runFacialRecognitionRepositoryContract(postgres, 'postgres');
    const sqliteResult = await runFacialRecognitionRepositoryContract(sqlite, 'sqlite');

    expect(sqliteResult).toEqual(postgresResult);
    expect(sqliteResult).toMatchObject({
      face: {
        id: ids.recognitionFace,
        personId: null,
        asset: {
          ownerId: ids.recognitionUser,
          visibility: AssetVisibility.Timeline,
        },
        faceSearch: {
          faceId: ids.recognitionFace,
          embedding: [1, ...Array.from({ length: 511 }, () => 0)],
        },
      },
      assignedFace: {
        id: ids.recognitionAssignedFace,
        personId: ids.recognitionPerson,
        faceSearch: {
          faceId: ids.recognitionAssignedFace,
          embedding: [0, 1, ...Array.from({ length: 510 }, () => 0)],
        },
      },
      missingEmbeddingFace: {
        id: ids.recognitionMissingEmbeddingFace,
        personId: null,
        faceSearch: null,
      },
      deletedFace: undefined,
      matchedFaceIds: [ids.recognitionFace],
    });
  });

  it('returns JSON-safe smart-search embeddings', async () => {
    const postgresResult = await runSmartSearchJsonContract(postgres, 'postgres');
    const sqliteResult = await runSmartSearchJsonContract(sqlite, 'sqlite');

    expect(sqliteResult).toEqual(postgresResult);
    expect(sqliteResult).toEqual({
      assetId: ids.smartSearchAsset,
      smartSearch: {
        assetId: ids.smartSearchAsset,
        embedding: [1, ...Array.from({ length: 511 }, () => 0)],
      },
    });
  });
});

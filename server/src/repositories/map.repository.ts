import { Injectable } from '@nestjs/common';
import { getName, registerLocale } from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';
import zhLocale from 'i18n-iso-countries/langs/zh.json';
import { Expression, Insertable, Kysely, NotNull, sql, SqlBool } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { citiesFile, reverseGeocodeMaxDistance } from 'src/constants';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility, SystemMetadataKey } from 'src/enum';
import { ConfigRepository } from 'src/repositories/config.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { DB } from 'src/schema';
import { GeodataAlternateNamesTable } from 'src/schema/tables/geodata-alternate-names.table';
import { GeodataPlacesTable } from 'src/schema/tables/geodata-places.table';
import { NaturalEarthCountriesTable } from 'src/schema/tables/natural-earth-countries.table';
import { isSqliteBackend } from 'src/utils/database-helpers';
import {
  getGeodataLanguageFallbacks,
  parseAlternateNameLine,
  readTextLines,
  selectLocalizedName,
} from 'src/utils/geodata';

export interface MapMarkerSearchOptions {
  isArchived?: boolean;
  isFavorite?: boolean;
  fileCreatedBefore?: Date;
  fileCreatedAfter?: Date;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface ReverseGeocodeResult {
  country: string | null;
  state: string | null;
  city: string | null;
}

interface MapDB extends DB {
  geodata_alternate_names_tmp: GeodataAlternateNamesTable;
  geodata_places_tmp: GeodataPlacesTable;
  naturalearth_countries_tmp: NaturalEarthCountriesTable;
}

interface AdminPlace {
  id: number | null;
  name: string;
}

const geodataImportVersion = 2;

registerLocale(enLocale);
registerLocale(zhLocale);

@Injectable()
export class MapRepository {
  constructor(
    private configRepository: ConfigRepository,
    private metadataRepository: SystemMetadataRepository,
    private logger: LoggingRepository,
    @InjectKysely() private db: Kysely<MapDB>,
  ) {
    this.logger.setContext(MapRepository.name);
  }

  async init(): Promise<void> {
    this.logger.log('Initializing metadata repository');
    const { resourcePaths } = this.configRepository.getEnv();
    const [geodataDate, alternateNamesDate] = await Promise.all([
      readFile(resourcePaths.geodata.dateFile, 'utf8'),
      readFile(resourcePaths.geodata.alternateNamesDateFile, 'utf8'),
    ]);

    // TODO move to service init
    const geocodingMetadata = await this.metadataRepository.get(SystemMetadataKey.ReverseGeocodingState);
    const shouldImportGeodata =
      geocodingMetadata?.lastUpdate !== geodataDate || geocodingMetadata?.importVersion !== geodataImportVersion;
    const shouldImportAlternateNames =
      geocodingMetadata?.lastAlternateNamesUpdate !== alternateNamesDate ||
      geocodingMetadata?.importVersion !== geodataImportVersion;
    if (!shouldImportGeodata && !shouldImportAlternateNames) {
      return;
    }

    if (shouldImportGeodata) {
      await Promise.all([this.importGeodata(), this.importNaturalEarthCountries()]);
    }
    if (shouldImportAlternateNames) {
      await this.importAlternateNames();
    }

    await this.metadataRepository.set(SystemMetadataKey.ReverseGeocodingState, {
      lastUpdate: geodataDate,
      lastAlternateNamesUpdate: alternateNamesDate,
      lastImportFileName: citiesFile,
      importVersion: geodataImportVersion,
    });

    this.logger.log('Geodata import completed');
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getAlbumMapMarkers(albumId: string) {
    return this.mapMarkersQuery()
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], [DummyValue.UUID]] })
  getMapMarkers(
    authUserId: string,
    ownerIds: string[],
    albumIds: string[],
    { isArchived, isFavorite, fileCreatedAfter, fileCreatedBefore }: MapMarkerSearchOptions = {},
  ) {
    return this.mapMarkersQuery()
      .$if(isArchived === true, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb('asset.visibility', '=', AssetVisibility.Timeline),
            eb.and([eb('asset.ownerId', '=', authUserId), eb('asset.visibility', '=', AssetVisibility.Archive)]),
          ]),
        ),
      )
      .$if(isArchived === false || isArchived === undefined, (qb) =>
        qb.where('asset.visibility', '=', AssetVisibility.Timeline),
      )
      .$if(isFavorite !== undefined, (q) => q.where('isFavorite', '=', isFavorite!))
      .$if(fileCreatedAfter !== undefined, (q) => q.where('fileCreatedAt', '>=', fileCreatedAfter!))
      .$if(fileCreatedBefore !== undefined, (q) => q.where('fileCreatedAt', '<=', fileCreatedBefore!))
      .where((eb) => {
        const expression: Expression<SqlBool>[] = [];

        if (ownerIds.length > 0) {
          expression.push(eb('ownerId', 'in', ownerIds));
        }

        if (albumIds.length > 0) {
          expression.push(
            eb.exists((eb) =>
              eb
                .selectFrom('album_asset')
                .select(sql`1`.as('1'))
                .whereRef('asset.id', '=', 'album_asset.assetId')
                .where('album_asset.albumId', 'in', albumIds),
            ),
          );
        }

        return eb.or(expression);
      })
      .execute();
  }

  private mapMarkersQuery() {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', (builder) =>
        builder
          .onRef('asset.id', '=', 'asset_exif.assetId')
          .on('asset_exif.latitude', 'is not', null)
          .on('asset_exif.longitude', 'is not', null),
      )
      .where('asset.deletedAt', 'is', null)
      .orderBy('fileCreatedAt', 'desc')
      .select([
        'id',
        'asset_exif.latitude as lat',
        'asset_exif.longitude as lon',
        'asset_exif.city',
        'asset_exif.state',
        'asset_exif.country',
      ])
      .$narrowType<{ lat: NotNull; lon: NotNull }>();
  }

  async reverseGeocode(point: GeoPoint): Promise<ReverseGeocodeResult> {
    this.logger.debug(`Request: ${point.latitude},${point.longitude}`);

    const latitudeRadius = reverseGeocodeMaxDistance / 111_320;
    const longitudeRadius = latitudeRadius / Math.max(Math.cos((point.latitude * Math.PI) / 180), 0.01);
    const response = isSqliteBackend()
      ? await this.db
          .selectFrom('geodata_places')
          .selectAll()
          .where('latitude', '>=', point.latitude - latitudeRadius)
          .where('latitude', '<=', point.latitude + latitudeRadius)
          .where('longitude', '>=', point.longitude - longitudeRadius)
          .where('longitude', '<=', point.longitude + longitudeRadius)
          .where(
            sql`haversine_distance(latitude, longitude, ${point.latitude}, ${point.longitude})`,
            '<=',
            reverseGeocodeMaxDistance,
          )
          .orderBy(sql`haversine_distance(latitude, longitude, ${point.latitude}, ${point.longitude})`)
          .limit(1)
          .executeTakeFirst()
      : await this.db
          .selectFrom('geodata_places')
          .selectAll()
          .where(
            sql`earth_box(ll_to_earth_public(${point.latitude}, ${point.longitude}), ${reverseGeocodeMaxDistance})`,
            '@>',
            sql`ll_to_earth_public(latitude, longitude)`,
          )
          .orderBy(
            sql`(earth_distance(ll_to_earth_public(${point.latitude}, ${point.longitude}), ll_to_earth_public(latitude, longitude)))`,
          )
          .limit(1)
          .executeTakeFirst();

    if (response) {
      this.logger.verboseFn(() => `Raw: ${JSON.stringify(response, null, 2)}`);

      const { countryCode } = response;
      const { reverseGeocoding } = this.configRepository.getEnv();
      const countryLanguage = reverseGeocoding.language === 'zh-CN' ? 'zh' : 'en';
      const [city, state] = await Promise.all([
        this.getLocalizedPlaceName(response.id, response.name),
        this.getLocalizedPlaceName(response.admin1Id, response.admin1Name),
      ]);
      const country = getName(countryCode, countryLanguage) ?? getName(countryCode, 'en') ?? null;

      return { country, state, city };
    }

    this.logger.log(
      `Empty response from database for city reverse geocoding lat: ${point.latitude}, lon: ${point.longitude}. Likely cause: no nearby large populated place (500+ within ${reverseGeocodeMaxDistance / 1000}km). Falling back to country boundaries.`,
    );

    const ne_response = isSqliteBackend()
      ? await this.db
          .selectFrom('naturalearth_countries')
          .selectAll()
          .where(sql`point_in_polygon(coordinates, ${point.longitude}, ${point.latitude})`, '=', 1)
          .limit(1)
          .executeTakeFirst()
      : await this.db
          .selectFrom('naturalearth_countries')
          .selectAll()
          .where('coordinates', '@>', sql<string>`point(${point.longitude}, ${point.latitude})`)
          .limit(1)
          .executeTakeFirst();

    if (!ne_response) {
      this.logger.log(
        `Empty response from database for natural earth country reverse geocoding lat: ${point.latitude}, lon: ${point.longitude}`,
      );

      return { country: null, state: null, city: null };
    }

    this.logger.verboseFn(() => `Raw: ${JSON.stringify(ne_response, ['id', 'admin', 'admin_a3', 'type'], 2)}`);

    const { admin_a3 } = ne_response;
    const { reverseGeocoding } = this.configRepository.getEnv();
    const countryLanguage = reverseGeocoding.language === 'zh-CN' ? 'zh' : 'en';
    const country = getName(admin_a3, countryLanguage) ?? getName(admin_a3, 'en') ?? null;
    const state = null;
    const city = null;

    return { country, state, city };
  }

  private async importNaturalEarthCountries() {
    const { resourcePaths } = this.configRepository.getEnv();
    const geoJSONData = JSON.parse(await readFile(resourcePaths.geodata.naturalEarthCountriesPath, 'utf8'));
    if (geoJSONData.type !== 'FeatureCollection' || !Array.isArray(geoJSONData.features)) {
      this.logger.fatal('Invalid GeoJSON FeatureCollection');
      return;
    }

    const entities: Insertable<NaturalEarthCountriesTable>[] = [];
    for (const feature of geoJSONData.features) {
      for (const entry of feature.geometry.coordinates) {
        const coordinates: number[][][] = feature.geometry.type === 'MultiPolygon' ? entry[0] : entry;
        const featureRecord: Insertable<NaturalEarthCountriesTable> = {
          admin: feature.properties.ADMIN,
          admin_a3: feature.properties.ADM0_A3,
          type: feature.properties.TYPE,
          coordinates: `(${coordinates.map((point) => `(${point[0]},${point[1]})`).join(', ')})`,
        };
        entities.push(featureRecord);
        if (feature.geometry.type === 'Polygon') {
          break;
        }
      }
    }

    if (isSqliteBackend()) {
      await this.db.transaction().execute(async (manager) => {
        await manager.deleteFrom('naturalearth_countries').execute();
        for (let index = 0; index < entities.length; index += 1000) {
          await manager
            .insertInto('naturalearth_countries')
            .values(entities.slice(index, index + 1000))
            .execute();
        }
      });
      return;
    }

    await this.db.transaction().execute(async (manager) => {
      await sql`CREATE TABLE naturalearth_countries_tmp
                (
                  LIKE naturalearth_countries INCLUDING ALL EXCLUDING INDEXES
                )`.execute(manager);
      await manager.schema.dropTable('naturalearth_countries').execute();
      await manager.schema.alterTable('naturalearth_countries_tmp').renameTo('naturalearth_countries').execute();
    });

    await this.db.insertInto('naturalearth_countries').values(entities).execute();
    await sql`ALTER TABLE naturalearth_countries ADD PRIMARY KEY (id) WITH (FILLFACTOR = 100)`.execute(this.db);
  }

  private async importGeodata() {
    const { resourcePaths } = this.configRepository.getEnv();
    const [admin1, admin2] = await Promise.all([
      this.loadAdmin(resourcePaths.geodata.admin1),
      this.loadAdmin(resourcePaths.geodata.admin2),
    ]);

    if (isSqliteBackend()) {
      await this.db.deleteFrom('geodata_places').execute();
      await this.loadCities500(admin1, admin2);
      return;
    }

    await this.db.schema.dropTable('geodata_places_tmp').ifExists().execute();
    await this.db.transaction().execute(async (manager) => {
      await sql`CREATE TABLE geodata_places_tmp
                (
                  LIKE geodata_places INCLUDING ALL EXCLUDING INDEXES
                )`.execute(manager);
      await manager.schema.dropTable('geodata_places').execute();
      await manager.schema.alterTable('geodata_places_tmp').renameTo('geodata_places').execute();
    });
    await this.db.schema
      .createIndex('IDX_geodata_gist_earthcoord')
      .on('geodata_places')
      .using('gist')
      .expression(sql`ll_to_earth_public(latitude, longitude)`)
      .execute();
    await this.loadCities500(admin1, admin2);
    await this.createGeodataIndices();
  }

  private async loadCities500(admin1Map: Map<string, AdminPlace>, admin2Map: Map<string, AdminPlace>) {
    const { resourcePaths } = this.configRepository.getEnv();
    const cities500 = resourcePaths.geodata.cities500;
    if (!existsSync(cities500)) {
      throw new Error(`Geodata file ${cities500} not found`);
    }

    this.logger.log(`Starting geodata import`);
    const startTime = performance.now();

    const sqlite = isSqliteBackend();
    const batchSize = sqlite ? 1000 : 5000;
    const maxPendingBatches = sqlite ? 1 : 9;
    let bufferGeodata = [];
    let count = 0;

    let futures = [];
    for await (const line of readTextLines(cities500)) {
      const lineSplit = line.split('\t');
      if ((lineSplit[7] === 'PPLX' && lineSplit[8] !== 'AU') || lineSplit[7] === 'PPLH') {
        continue;
      }

      const geoData = {
        id: Number.parseInt(lineSplit[0]),
        name: lineSplit[1],
        alternateNames: lineSplit[3],
        latitude: Number.parseFloat(lineSplit[4]),
        longitude: Number.parseFloat(lineSplit[5]),
        countryCode: lineSplit[8],
        admin1Code: lineSplit[10],
        admin2Code: lineSplit[11],
        modificationDate: lineSplit[18],
        admin1Id: admin1Map.get(`${lineSplit[8]}.${lineSplit[10]}`)?.id ?? null,
        admin1Name: admin1Map.get(`${lineSplit[8]}.${lineSplit[10]}`)?.name ?? null,
        admin2Id: admin2Map.get(`${lineSplit[8]}.${lineSplit[10]}.${lineSplit[11]}`)?.id ?? null,
        admin2Name: admin2Map.get(`${lineSplit[8]}.${lineSplit[10]}.${lineSplit[11]}`)?.name ?? null,
      };
      bufferGeodata.push(geoData);
      if (bufferGeodata.length >= batchSize) {
        const curLength = bufferGeodata.length;
        futures.push(
          this.db
            .insertInto('geodata_places')
            .values(bufferGeodata)
            .execute()
            .then(() => {
              count += curLength;
              if (count % 10_000 === 0) {
                this.logger.log(`${count} geodata records imported`);
              }
            }),
        );
        bufferGeodata = [];
        // leave spare connection for other queries
        if (futures.length >= maxPendingBatches) {
          await Promise.all(futures);
          futures = [];
        }
      }
    }

    if (bufferGeodata.length > 0) {
      await this.db.insertInto('geodata_places').values(bufferGeodata).execute();
      count += bufferGeodata.length;
    }

    await Promise.all(futures);

    const duration = performance.now() - startTime;
    const seconds = duration / 1000;
    const recordsPerSecond = Math.round(count / seconds);

    this.logger.log(
      `Successfully imported ${count} geodata records in ${seconds.toFixed(2)}s (${recordsPerSecond} records/second)`,
    );
  }

  private async loadAdmin(filePath: string) {
    if (!existsSync(filePath)) {
      this.logger.error(`Geodata file ${filePath} not found`);
      throw new Error(`Geodata file ${filePath} not found`);
    }

    const adminMap = new Map<string, AdminPlace>();
    for await (const line of readTextLines(filePath)) {
      const lineSplit = line.split('\t');
      const id = Number.parseInt(lineSplit[3]);
      adminMap.set(lineSplit[0], { id: Number.isNaN(id) ? null : id, name: lineSplit[1] });
    }

    return adminMap;
  }

  private languageFallbacks() {
    const { language } = this.configRepository.getEnv().reverseGeocoding;
    return getGeodataLanguageFallbacks(language);
  }

  private async getLocalizedPlaceName(geonameId: number | null, fallback: string | null) {
    if (geonameId === null) {
      return fallback;
    }

    const languages = this.languageFallbacks();
    const names = await this.db
      .selectFrom('geodata_alternate_names')
      .select(['id', 'isolanguage', 'name', 'isPreferredName', 'isShortName', 'isColloquial'])
      .where('geonameId', '=', geonameId)
      .where('isolanguage', 'in', languages)
      .where('isHistoric', '=', false)
      .execute();

    return selectLocalizedName(names, languages, fallback);
  }

  private async importAlternateNames() {
    const { resourcePaths } = this.configRepository.getEnv();
    const filePath = resourcePaths.geodata.alternateNames;
    if (!existsSync(filePath)) {
      throw new Error(`Geodata file ${filePath} not found`);
    }

    this.logger.log('Starting localized GeoNames alternate-name import');
    const batchSize = isSqliteBackend() ? 1000 : 5000;
    let count = 0;

    await this.db.transaction().execute(async (manager) => {
      await manager.deleteFrom('geodata_alternate_names').execute();
      let buffer: Insertable<GeodataAlternateNamesTable>[] = [];
      for await (const line of readTextLines(filePath)) {
        const alternateName = parseAlternateNameLine(line);
        if (!alternateName) {
          continue;
        }
        buffer.push(alternateName);

        if (buffer.length >= batchSize) {
          await manager
            .insertInto('geodata_alternate_names')
            .values(buffer)
            .onConflict((oc) => oc.column('id').doNothing())
            .execute();
          count += buffer.length;
          buffer = [];
          if (count % 100_000 === 0) {
            this.logger.log(`${count} alternate geodata records imported`);
          }
        }
      }

      if (buffer.length > 0) {
        await manager
          .insertInto('geodata_alternate_names')
          .values(buffer)
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
        count += buffer.length;
      }
    });

    this.logger.log(`Successfully imported ${count} localized alternate geodata records`);
  }

  private createGeodataIndices() {
    return Promise.all([
      sql`ALTER TABLE geodata_places ADD PRIMARY KEY (id) WITH (FILLFACTOR = 100)`.execute(this.db),
      this.db.schema
        .createIndex(`idx_geodata_places_alternate_names`)
        .on('geodata_places')
        .using('gin (f_unaccent("alternateNames") gin_trgm_ops)')
        .execute(),
      this.db.schema
        .createIndex(`idx_geodata_places_name`)
        .on('geodata_places')
        .using('gin (f_unaccent(name) gin_trgm_ops)')
        .execute(),
      this.db.schema
        .createIndex(`idx_geodata_places_admin1_name`)
        .on('geodata_places')
        .using('gin (f_unaccent("admin1Name") gin_trgm_ops)')
        .execute(),
      this.db.schema
        .createIndex(`idx_geodata_places_admin2_name`)
        .on('geodata_places')
        .using('gin (f_unaccent("admin2Name") gin_trgm_ops)')
        .execute(),
    ]);
  }
}

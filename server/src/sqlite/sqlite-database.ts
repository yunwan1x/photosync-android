import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { v4 as uuidV4, v7 as uuidV7 } from 'uuid';

const EARTH_RADIUS_METERS = 6_371_008.8;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

export const haversineDistance = (latitude1: number, longitude1: number, latitude2: number, longitude2: number) => {
  const latitudeDelta = radians(latitude2 - latitude1);
  const longitudeDelta = radians(longitude2 - longitude1);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const pointInPolygon = (coordinates: string, longitude: number, latitude: number) => {
  const points = [...coordinates.matchAll(/\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);
  if (points.length < 3) {
    return 0;
  }

  let isInside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [x, y] = points[index];
    const [previousX, previousY] = points[previous];
    const intersects =
      y > latitude !== previousY > latitude && longitude < ((previousX - x) * (latitude - y)) / (previousY - y) + x;
    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside ? 1 : 0;
};

const unaccentExpansions = new Map([
  ['Æ', 'AE'],
  ['æ', 'ae'],
  ['Ð', 'D'],
  ['ð', 'd'],
  ['Đ', 'D'],
  ['đ', 'd'],
  ['Ø', 'O'],
  ['ø', 'o'],
  ['Þ', 'TH'],
  ['þ', 'th'],
  ['Ł', 'L'],
  ['ł', 'l'],
  ['Œ', 'OE'],
  ['œ', 'oe'],
  ['ß', 'ss'],
  ['ẞ', 'SS'],
]);

const unaccent = (value: string | null) =>
  value === null
    ? null
    : [...value.normalize('NFD').replaceAll(/[\u0300-\u036F]/g, '')]
        .map((character) => unaccentExpansions.get(character) ?? character)
        .join('');

const postgresReplacementToJavascript = (replacement: string) => {
  let result = '';
  for (let index = 0; index < replacement.length; index++) {
    const character = replacement[index];
    if (character === '$') {
      result += '$$';
      continue;
    }
    if (character !== '\\' || index === replacement.length - 1) {
      result += character;
      continue;
    }

    const next = replacement[++index];
    if (/^[1-9]$/.test(next)) {
      result += `$${next}`;
    } else if (next === '&') {
      result += '$&';
    } else {
      result += next;
    }
  }
  return result;
};

export const createSqliteDatabase = (path: string): Database.Database => {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }

  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.pragma('case_sensitive_like = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 10000');
  database.pragma('wal_autocheckpoint = 1000');
  database.pragma('recursive_triggers = OFF');

  sqliteVec.load(database);

  database.function('immich_uuid_v7', { deterministic: false, varargs: true }, (value?: string | number) => {
    if (value === undefined || value === null) {
      return uuidV7();
    }
    const milliseconds = typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(milliseconds) ? uuidV7({ msecs: milliseconds }) : uuidV7();
  });
  database.function('immich_uuid_v4', { deterministic: false }, () => uuidV4());
  database.function('immich_now', { deterministic: false }, () => new Date().toISOString());
  database.function('f_unaccent', { deterministic: true }, unaccent);
  database.function('immich_lower', { deterministic: true }, (value: string | null) =>
    value === null ? null : value.toLocaleLowerCase('en-US'),
  );
  database.function('regexp_replace', { deterministic: true }, (value: string, pattern: string, replacement: string) =>
    value.replace(new RegExp(pattern), postgresReplacementToJavascript(replacement)),
  );
  database.function(
    'haversine_distance',
    { deterministic: true },
    (latitude1: number, longitude1: number, latitude2: number, longitude2: number) =>
      haversineDistance(latitude1, longitude1, latitude2, longitude2),
  );
  database.function('point_in_polygon', { deterministic: true }, pointInPolygon);

  return database;
};

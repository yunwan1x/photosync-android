import { Insertable, Selectable } from 'kysely';
import { createReadStream } from 'node:fs';
import { GeodataAlternateNamesTable } from 'src/schema/tables/geodata-alternate-names.table';

export type ReverseGeocodingLanguage = 'zh-CN' | 'en';

/**
 * Streams a large UTF-8 text file with backpressure. Node's readline async
 * iterator can close while a slow database batch is still being awaited,
 * which causes ERR_USE_AFTER_CLOSE near the end of large imports.
 */
export async function* readTextLines(filePath: string) {
  const input = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  let remainder = '';

  for await (const chunk of input) {
    remainder += chunk;
    let newline = remainder.indexOf('\n');
    while (newline >= 0) {
      const line = remainder.slice(0, newline);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      remainder = remainder.slice(newline + 1);
      newline = remainder.indexOf('\n');
    }
  }

  if (remainder.length > 0) {
    yield remainder.endsWith('\r') ? remainder.slice(0, -1) : remainder;
  }
}

export const getGeodataLanguageFallbacks = (language: ReverseGeocodingLanguage) =>
  language === 'zh-CN' ? ['zh-CN', 'zh-Hans', 'zh'] : ['en'];

const supportedAlternateNameLanguages = new Set(['zh-CN', 'zh-Hans', 'zh', 'en']);

type LocalizedName = Pick<
  Selectable<GeodataAlternateNamesTable>,
  'id' | 'isolanguage' | 'name' | 'isPreferredName' | 'isShortName' | 'isColloquial'
>;

export const selectLocalizedName = (names: LocalizedName[], languages: string[], fallback: string | null) => {
  for (const language of languages) {
    const match = names
      .filter(({ isolanguage }) => isolanguage === language)
      .toSorted(
        (left, right) =>
          Number(right.isPreferredName) - Number(left.isPreferredName) ||
          Number(right.isShortName) - Number(left.isShortName) ||
          Number(left.isColloquial) - Number(right.isColloquial) ||
          left.id - right.id,
      )[0];
    if (match) {
      return match.name;
    }
  }

  return fallback;
};

export const parseAlternateNameLine = (line: string): Insertable<GeodataAlternateNamesTable> | undefined => {
  const fields = line.split('\t');
  if (fields.length < 4) {
    return;
  }

  const id = Number.parseInt(fields[0]);
  const geonameId = Number.parseInt(fields[1]);
  if (
    Number.isNaN(id) ||
    Number.isNaN(geonameId) ||
    !supportedAlternateNameLanguages.has(fields[2]) ||
    fields[3].length === 0 ||
    fields[7] === '1'
  ) {
    return;
  }

  return {
    id,
    geonameId,
    isolanguage: fields[2] || null,
    name: fields[3],
    isPreferredName: fields[4] === '1',
    isShortName: fields[5] === '1',
    isColloquial: fields[6] === '1',
    isHistoric: fields[7] === '1',
    validFrom: fields[8] || null,
    validTo: fields[9] || null,
  };
};

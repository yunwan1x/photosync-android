import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getGeodataLanguageFallbacks,
  parseAlternateNameLine,
  readTextLines,
  selectLocalizedName,
} from 'src/utils/geodata';

describe('geodata utilities', () => {
  it('uses Simplified Chinese fallbacks in priority order', () => {
    expect(getGeodataLanguageFallbacks('zh-CN')).toEqual(['zh-CN', 'zh-Hans', 'zh']);
    expect(getGeodataLanguageFallbacks('en')).toEqual(['en']);
  });

  it('prefers the requested language and preferred name', () => {
    const names = [
      {
        id: 1,
        isolanguage: 'zh',
        name: '北京市',
        isPreferredName: false,
        isShortName: false,
        isColloquial: false,
      },
      {
        id: 2,
        isolanguage: 'zh-CN',
        name: '北京',
        isPreferredName: true,
        isShortName: false,
        isColloquial: false,
      },
    ];

    expect(selectLocalizedName(names, ['zh-CN', 'zh-Hans', 'zh'], 'Beijing')).toBe('北京');
  });

  it('falls back to the original name when no translation exists', () => {
    expect(selectLocalizedName([], ['zh-CN', 'zh-Hans', 'zh'], 'München')).toBe('München');
  });

  it('parses every alternateNamesV2 field without discarding name types', () => {
    expect(parseAlternateNameLine('42\t1816670\tzh-CN\t北京\t1\t1\t0\t0\t1900\t')).toEqual({
      id: 42,
      geonameId: 1_816_670,
      isolanguage: 'zh-CN',
      name: '北京',
      isPreferredName: true,
      isShortName: true,
      isColloquial: false,
      isHistoric: false,
      validFrom: '1900',
      validTo: null,
    });
  });

  it('rejects malformed alternate-name rows', () => {
    expect(parseAlternateNameLine('invalid')).toBeUndefined();
    expect(parseAlternateNameLine('x\t1\tzh\t北京')).toBeUndefined();
    expect(parseAlternateNameLine('1\t1\tzh\t')).toBeUndefined();
  });

  it('accepts only current Simplified Chinese and English alternate names', () => {
    expect(parseAlternateNameLine('1\t1\tzh-CN\t北京')).toBeDefined();
    expect(parseAlternateNameLine('2\t1\tzh-Hans\t北京')).toBeDefined();
    expect(parseAlternateNameLine('3\t1\tzh\t北京')).toBeDefined();
    expect(parseAlternateNameLine('4\t1\ten\tBeijing')).toBeDefined();
    expect(parseAlternateNameLine('5\t1\tfr\tPékin')).toBeUndefined();
    expect(parseAlternateNameLine('6\t1\tzh\t北平\t0\t0\t0\t1')).toBeUndefined();
  });

  it('streams every line with backpressure while the consumer is slow', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'immich-lines-'));
    const filePath = join(folder, 'lines.txt');
    const expected = Array.from({ length: 10_001 }, (_, index) => `line-${index}`);
    await writeFile(filePath, `${expected.join('\r\n')}\r\n`);

    try {
      const actual: string[] = [];
      for await (const line of readTextLines(filePath)) {
        actual.push(line);
        if (actual.length % 1000 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
      expect(actual).toEqual(expected);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

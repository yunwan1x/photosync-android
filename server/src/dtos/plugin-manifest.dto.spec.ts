import { PluginManifestDto } from 'src/dtos/plugin-manifest.dto';

const manifest = {
  name: 'test-plugin',
  version: '1.0.0',
  title: 'Test plugin',
  description: 'Test plugin manifest',
  wasmPath: 'plugin.wasm',
  author: 'Immich',
};

const method = {
  name: 'testMethod',
  title: 'Test method',
  description: 'Test method description',
  types: ['AssetV1'],
};

describe('PluginManifestDto', () => {
  it.each([
    { input: undefined, expected: [] },
    { input: [], expected: [] },
    { input: ['filter'], expected: ['filter'] },
  ])('normalizes method uiHints $input to $expected', ({ input, expected }) => {
    const result = PluginManifestDto.schema.parse({
      ...manifest,
      methods: [{ ...method, ...(input === undefined ? {} : { uiHints: input }) }],
    });

    expect(result.methods[0].uiHints).toEqual(expected);
  });
});

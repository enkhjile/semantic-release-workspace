import { expect, test } from 'vitest';
import { editManifest } from '../src/manifests.js';

test('Cargo edits preserve comments, quoted target keys and unrelated formatting', () => {
  const before =
    '# keep\n[package]\nname = "app"\nversion.workspace = true # inheritance\n[target.\'cfg(unix)\'.dependencies]\nrenamed = { package="lib", path="../lib" } # dependency\n';
  const result = editManifest('Cargo.toml', before, [
    { field: ['package', 'version'], value: '1.2.0' },
    {
      field: ['target', 'cfg(unix)', 'dependencies', 'renamed', 'version'],
      value: '^2.0.0',
    },
  ]);
  expect(result).toContain('# keep');
  expect(result).toContain('version = "1.2.0" # inheritance');
  expect(result).toContain('package="lib", path="../lib"');
  expect(result).toContain('version = "^2.0.0"');
  expect(result).toContain('# dependency');
});

test('JSON edits retain unknown fields and original indentation', () => {
  const result = editManifest(
    'package.json',
    '{\n\t"name": "app",\n\t"custom": {"keep": true}\n}\n',
    [{ field: ['version'], value: '1.2.0' }],
  );
  expect(JSON.parse(result)).toEqual({
    name: 'app',
    custom: { keep: true },
    version: '1.2.0',
  });
  expect(result).toContain('\t"version"');
});

test('Cargo explicit inheritance subtables become valid independent versions', () => {
  const before =
    '[package]\nname = "app"\n[package.version]\nworkspace = true # keep\n[dependencies]\n';
  const result = editManifest('Cargo.toml', before, [
    { field: ['package', 'version'], value: '1.2.0' },
  ]);
  expect(result).toContain('version = "1.2.0"');
  expect(result).not.toContain('[package.version]');
  expect(result).toContain('# keep');
});

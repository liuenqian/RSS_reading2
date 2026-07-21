import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
const instructions = await readFile(new URL('../docs/WINDOWS_PORTABLE.md', import.meta.url), 'utf8');

test('Windows CI creates a complete portable archive', () => {
  assert.match(workflow, /name: Create Windows portable package/);
  assert.match(workflow, /Copy-Item \(Join-Path \$releaseDir 'cento\.exe'\) \(Join-Path \$portableDir 'RSS Reading\.exe'\)/);
  assert.match(workflow, /Copy-Item 'src-tauri\/resources' \(Join-Path \$portableDir 'resources'\) -Recurse/);
  assert.match(workflow, /Windows-x64_Portable\.zip[\s\S]*Compress-Archive/);
  assert.match(workflow, /Get-FileHash \$archive -Algorithm SHA256/);
});

test('portable archive is attached to tagged releases and workflow artifacts', () => {
  assert.match(workflow, /name: Upload Windows portable package to release[\s\S]*gh release upload/);
  assert.match(workflow, /Get-ChildItem \$portableRoot -Filter '\*\.zip'/);
  assert.match(workflow, /Get-ChildItem \$portableRoot -Filter '\*\.sha256'/);
  assert.match(workflow, /release\/portable\/\*\.zip/);
  assert.match(workflow, /release\/portable\/\*\.sha256/);
});

test('portable instructions explain extraction, shared local data, and WebView2', () => {
  assert.match(instructions, /无需安装/);
  assert.match(instructions, /安装版与便携版使用相同的应用标识/);
  assert.match(instructions, /WebView2 Runtime/);
  assert.match(instructions, /仍需要网络/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredNames = new Set(['.git', 'node_modules', 'dist', 'target', 'playwright-report', 'test-results', '.env']);
const brandedPackage = '@' + 'vm' + 'aos/webrtc-sdk';
const neutralPackage = '@' + 'izuanke/webrtc-sdk';
const permittedBrandedPackage = new RegExp('@' + 'vm' + 'aos/webrtc-sdk(?![A-Za-z0-9._-])', 'g');
const brandPattern = new RegExp('vm' + 'aos', 'i');
const args = process.argv.slice(2);
let stagedOnly = false, against = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--staged' && !stagedOnly) stagedOnly = true;
  else if (args[i] === '--against' && against === null && args[i + 1] && !args[i + 1].startsWith('--')) against = resolve(args[++i]);
  else throw new Error('Usage: node scripts/verify-parity.mjs [--staged] [--against <other-samples-directory>]');
}
async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
function ignoredPath(rel, isFile) {
  const parts = rel.split('/');
  return parts.some((part, index) => ignoredNames.has(part)
      || part.startsWith('.env.') && part !== '.env.example'
      || part.endsWith('.log')
      || part === 'public' && parts[index + 1] === 'sdk')
    || isFile && /^openapi-go-samples\/[^/]*openapi-samples$/.test(rel);
}
async function files(dir, base, other) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), rel = relative(base, path).replaceAll('\\', '/');
    assert(!entry.isSymbolicLink(), `symbolic links are not allowed in samples: ${rel}`);
    if (path === other || ignoredPath(rel, entry.isFile())) continue;
    if (entry.isDirectory()) result.push(...await files(path, base, other));
    else if (entry.isFile()) result.push(rel);
  }
  return result.sort();
}
async function scan(base, other) {
  const readme = await readFile(join(base, 'README.md'), 'utf8');
  const isBrandedPackage = readme.includes(brandedPackage);
  const isNeutralPackage = readme.includes(neutralPackage);
  assert.notEqual(isBrandedPackage, isNeutralPackage, 'README must identify exactly one SDK package');
  function checkContent(text, path) {
    assert(!brandPattern.test(isBrandedPackage ? text.replace(permittedBrandedPackage, '') : text), `unexpected brand in ${path}`);
    if (isBrandedPackage) assert(!text.includes(neutralPackage), `unexpected package in ${path}`);
    if (isNeutralPackage) assert(!text.includes(brandedPackage), `unexpected package in ${path}`);
  }
  // Ignored build output may nevertheless be force-added to Git. Check the index
  // as well as the filesystem walk when this copy is in a repository.
  const tracked = spawnSync('git', ['-C', base, 'ls-files', '--stage', '-z', '--', '.'], { encoding: 'utf8' });
  if (tracked.status === 0) {
    for (const entry of tracked.stdout.split('\0')) {
      if (!entry) continue;
      const tab = entry.indexOf('\t');
      assert(tab >= 0, 'invalid Git index entry');
      const path = entry.slice(tab + 1);
      assert(!entry.startsWith('120000 '), 'tracked symbolic links are not allowed in samples');
      assert(!entry.startsWith('160000 '), 'tracked submodules are not allowed in samples');
      assert(!ignoredPath(path, true), `tracked local artifact is not allowed in samples: ${path}`);
    }
    // A staged blob can differ from its working file, including after a
    // partial stage or a subsequent edit. Inspect only staged additions and
    // changes; old tracked files awaiting deletion are not this commit's diff.
    const staged = spawnSync('git', ['-C', base, 'diff', '--cached', '--name-only', '--diff-filter=ACMR', '--relative', '-z', '--', '.'], { encoding: 'utf8' });
    assert.equal(staged.status, 0, 'cannot inspect staged sample files');
    const otherRelative = other ? relative(base, other) : '';
    const nestedOther = otherRelative && otherRelative !== '..' && !otherRelative.startsWith('..' + sep) && !isAbsolute(otherRelative);
    for (const path of staged.stdout.split('\0')) {
      if (!path) continue;
      const absolute = resolve(base, path);
      if (nestedOther && (absolute === other || absolute.startsWith(other + sep))) continue;
      assert(!brandPattern.test(path), `brand in staged path: ${path}`);
      const blob = spawnSync('git', ['-C', base, 'show', `:./${path}`], { maxBuffer: 32 * 1024 * 1024 });
      assert.equal(blob.status, 0, `cannot read staged sample file: ${path}`);
      const text = blob.stdout.toString('latin1');
      checkContent(text, `staged ${path}`);
      if (path === 'README.md') {
        assert(text.includes(isBrandedPackage ? brandedPackage : neutralPackage), 'staged README must identify the SDK package');
      }
    }
  }
  const paths = await files(base, base, other);
  const contents = new Map();
  for (const path of paths) {
    assert(!brandPattern.test(path), `brand in path: ${path}`);
    const data = await readFile(join(base, path));
    // Latin-1 round trips bytes so binary assets are compared without UTF-8 corruption.
    const text = data.toString('latin1');
    checkContent(text, path);
    contents.set(path, text);
  }
  return { paths, contents, isBrandedPackage };
}
// Review the exact contents that a commit would record, not the working
// files. This is opt-in because the existing baseline can contain old files
// that have been removed in the working tree but not staged yet.
async function scanIndex(base, other) {
  let cwd = base;
  while (!await exists(cwd)) {
    const parent = dirname(cwd);
    assert.notEqual(parent, cwd, `no Git repository for ${base}`);
    cwd = parent;
  }
  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert.equal(top.status, 0, `no Git repository for ${base}`);
  const repository = resolve(top.stdout.replace(/\r?\n$/, ''));
  const prefix = relative(repository, base);
  assert(prefix !== '..' && !prefix.startsWith('..' + sep) && !isAbsolute(prefix), `samples outside Git repository: ${base}`);
  const prefixText = prefix ? prefix.replaceAll('\\', '/') + '/' : '';
  const list = spawnSync('git', ['--literal-pathspecs', '-C', repository, 'ls-files', '--stage', '-z', '--', prefixText ? prefixText.slice(0, -1) : '.'], { encoding: 'utf8' });
  assert.equal(list.status, 0, `cannot inspect sample index: ${base}`);
  const contents = new Map();
  const modes = new Map();
  const otherRelative = other ? relative(base, other) : '';
  const nestedOther = otherRelative && otherRelative !== '..' && !otherRelative.startsWith('..' + sep) && !isAbsolute(otherRelative);
  for (const entry of list.stdout.split('\0')) {
    if (!entry) continue;
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry);
    assert(match, 'invalid Git index entry');
    const [, mode, oid, stage, repositoryPath] = match;
    assert(repositoryPath.startsWith(prefixText), `sample index path outside copy: ${repositoryPath}`);
    const path = repositoryPath.slice(prefixText.length);
    const absolute = resolve(base, path);
    if (nestedOther && (absolute === other || absolute.startsWith(other + sep))) continue;
    assert.equal(stage, '0', `unmerged sample index entry: ${path}`);
    assert(mode === '100644' || mode === '100755', `non-file index entry is not allowed in samples: ${path}`);
    assert(!ignoredPath(path, true), `tracked local artifact is not allowed in samples: ${path}`);
    assert(!brandPattern.test(path), `brand in staged path: ${path}`);
    const blob = spawnSync('git', ['-C', repository, 'cat-file', 'blob', oid], { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(blob.status, 0, `cannot read sample index blob: ${path}`);
    contents.set(path, blob.stdout.toString('latin1'));
    modes.set(path, mode);
  }
  const readme = contents.get('README.md');
  assert(readme !== undefined, `staged README is missing: ${base}`);
  const isBrandedPackage = readme.includes(brandedPackage);
  const isNeutralPackage = readme.includes(neutralPackage);
  assert.notEqual(isBrandedPackage, isNeutralPackage, 'staged README must identify exactly one SDK package');
  for (const [path, text] of contents) {
    assert(!brandPattern.test(isBrandedPackage ? text.replace(permittedBrandedPackage, '') : text), `unexpected brand in staged ${path}`);
    if (isBrandedPackage) assert(!text.includes(neutralPackage), `unexpected package in staged ${path}`);
    if (isNeutralPackage) assert(!text.includes(brandedPackage), `unexpected package in staged ${path}`);
  }
  return { paths: [...contents.keys()].sort(), contents, modes, isBrandedPackage };
}
const automatic = join(root, 'izuanke-samples');
let other = against;
if (other === null) {
  if (stagedOnly) {
    const stagedReadme = spawnSync('git', ['-C', root, 'show', ':./README.md'], { encoding: 'utf8' });
    assert.equal(stagedReadme.status, 0, 'staged README is missing');
    const stagedOther = spawnSync('git', ['-C', root, 'cat-file', '-e', ':./izuanke-samples/README.md']);
    if (stagedReadme.stdout.includes(brandedPackage) && stagedOther.status === 0) other = automatic;
    assert(other, 'staged parity requires both sample copies; stage izuanke-samples or specify --against');
  } else {
    const rootReadme = await readFile(join(root, 'README.md'), 'utf8');
    if (rootReadme.includes(brandedPackage) && await exists(automatic)) other = automatic;
  }
}
const first = stagedOnly ? await scanIndex(root, other) : await scan(root, other);
if (other === null) {
  console.log(`Verified ${first.paths.length} files for brand neutrality; parity comparison skipped (no second samples directory).`);
} else {
  const second = stagedOnly ? await scanIndex(other, root) : await scan(other, root);
  assert.notEqual(first.isBrandedPackage, second.isBrandedPackage, 'sample directories must use different SDK packages');
  assert.deepEqual(first.paths, second.paths, 'sample file lists must match');
  const normalize = text => text.replaceAll(brandedPackage, '<sdk-package>').replaceAll(neutralPackage, '<sdk-package>');
  for (const path of first.paths) {
    assert.equal(normalize(first.contents.get(path)), normalize(second.contents.get(path)), `sample mismatch: ${path}`);
    if (stagedOnly) assert.equal(first.modes.get(path), second.modes.get(path), `sample mode mismatch: ${path}`);
  }
  console.log(`Verified ${first.paths.length} matching ${stagedOnly ? 'staged ' : ''}sample files.`);
}

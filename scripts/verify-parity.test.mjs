import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const verifier = join(dirname(fileURLToPath(import.meta.url)), 'verify-parity.mjs');
const brand = 'vm' + 'aos';
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'samples-parity-'));
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(verifier, join(root, 'scripts/verify-parity.mjs'));
    await writeFile(join(root, 'README.md'), '@' + 'izuanke/webrtc-sdk');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function verify(root, ...args) {
  return spawnSync(process.execPath, [join(root, 'scripts/verify-parity.mjs'), ...args], { encoding: 'utf8' });
}

test('checks ordinary nested files even when named like the Go output binary', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/openapi-samples'), brand);
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected brand in nested\/openapi-samples/);
  });
});

test('rejects symbolic links instead of silently omitting their contents', async () => {
  await fixture(async root => {
    await symlink('README.md', join(root, 'linked-example'));
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symbolic links are not allowed/);
  });
});

test('rejects symbolic links even when their names match excluded local artifacts', async () => {
  for (const path of ['node_modules', '.env', 'izuanke-samples', 'openapi-go-samples/openapi-samples', 'openapi-go-samples/debug-openapi-samples']) {
    await fixture(async root => {
      if (path.includes('/')) await mkdir(join(root, 'openapi-go-samples'));
      await symlink(join(root, 'README.md'), join(root, path));
      const result = verify(root);
      assert.notEqual(result.status, 0, path);
      assert.match(result.stderr, /symbolic links are not allowed/, path);
    });
  }
});

test('rejects force-added symbolic links inside excluded build directories', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    await mkdir(join(root, 'node_modules'));
    await symlink('../README.md', join(root, 'node_modules/linked-example'));
    assert.equal(git('add', '-f', 'node_modules/linked-example').status, 0);
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tracked symbolic links are not allowed/);
  });
});

test('rejects force-added ordinary local artifacts but accepts tracked .env.example', async () => {
  for (const path of ['node_modules/pkg/index.js', 'dist/app.js', 'public/sdk/browser.js', '.env', '.env.local', 'target/app.jar', 'test-results/result.txt', 'run.log', 'openapi-go-samples/openapi-samples', 'openapi-go-samples/debug-openapi-samples']) {
    await fixture(async root => {
      const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      assert.equal(git('init', '-q').status, 0);
      await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n**/public/sdk/\n.env\n.env.*\n!.env.example\ntarget/\ntest-results/\n*.log\nopenapi-go-samples/openapi-samples\n');
      await writeFile(join(root, '.env.example'), 'OPENAPI_BASE_URL=https://openapi.sample.com');
      assert.equal(git('add', '.env.example').status, 0);
      assert.equal(verify(root).status, 0, '.env.example');
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), 'local output');
      assert.equal(git('add', '-f', path).status, 0, path);
      const result = verify(root);
      assert.notEqual(result.status, 0, path);
      assert.match(result.stderr, /tracked local artifact is not allowed/, path);
    });
  }
});

test('scans a nested izuanke-samples directory in the neutral copy', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'izuanke-samples'));
    await writeFile(join(root, 'izuanke-samples/readme.txt'), brand);
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected brand in izuanke-samples\/readme.txt/);
  });
});

test('does not ignore a directory named like the Go output binary', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'openapi-go-samples/openapi-samples'), { recursive: true });
    await writeFile(join(root, 'openapi-go-samples/openapi-samples/readme.txt'), brand);
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected brand in openapi-go-samples\/openapi-samples\/readme.txt/);
  });
});

test('excludes only the known Go build output at its actual path', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'openapi-go-samples'));
    await writeFile(join(root, 'openapi-go-samples', brand + '-openapi-samples'), brand);
    assert.equal(verify(root).status, 0);
  });
});


test('rejects the other SDK package in a branded copy', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'README.md'), '@' + brand + '/webrtc-sdk');
    await writeFile(join(root, 'example.js'), '@' + 'izuanke/webrtc-sdk');
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected package in example\.js/);
  });
});

test('does not exempt a different package sharing the permitted package prefix', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'README.md'), '@' + brand + '/webrtc-sdk');
    await writeFile(join(root, 'example.js'), '@' + brand + '/webrtc-sdk-evil');
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected brand in example\.js/);
  });
});

test('checks staged bytes when the working file has since been cleaned', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    await writeFile(join(root, 'example.js'), brand);
    assert.equal(git('add', 'example.js').status, 0);
    await writeFile(join(root, 'example.js'), 'neutral');
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected brand in staged example\.js/);
  });
});

test('checks a staged path even if it has disappeared from the working tree', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    const name = brand + '-example.js';
    await writeFile(join(root, name), 'neutral');
    assert.equal(git('add', name).status, 0);
    await rm(join(root, name));
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /brand in staged path/);
  });
});

test('allows a staged deletion of an old branded file', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    const name = brand + '-old.js';
    await writeFile(join(root, name), brand);
    assert.equal(git('add', name).status, 0);
    assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'old fixture').status, 0);
    await rm(join(root, name));
    assert.equal(git('add', '-u', name).status, 0);
    assert.equal(verify(root).status, 0);
  });
});

test('checks staged SDK package names in the correct copy', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    await writeFile(join(root, 'README.md'), '@' + brand + '/webrtc-sdk');
    await writeFile(join(root, 'example.js'), '@' + 'izuanke/webrtc-sdk');
    assert.equal(git('add', 'example.js').status, 0);
    await writeFile(join(root, 'example.js'), '@' + brand + '/webrtc-sdk');
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected package in staged example\.js/);
  });
});

test('checks staged files relative to a nested neutral copy', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    await writeFile(join(root, 'README.md'), '@' + brand + '/webrtc-sdk');
    await mkdir(join(root, 'izuanke-samples/scripts'), { recursive: true });
    await copyFile(verifier, join(root, 'izuanke-samples/scripts/verify-parity.mjs'));
    await writeFile(join(root, 'izuanke-samples/README.md'), '@' + 'izuanke/webrtc-sdk');
    await writeFile(join(root, 'example.js'), 'neutral');
    await writeFile(join(root, 'izuanke-samples/example.js'), brand);
    assert.equal(git('add', 'izuanke-samples/example.js').status, 0);
    await writeFile(join(root, 'izuanke-samples/example.js'), 'neutral');
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected brand in staged example\.js/);
  });
});

test('rejects a staged Git submodule', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('add', 'README.md').status, 0);
    assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture').status, 0);
    const revision = git('rev-parse', 'HEAD').stdout.trim();
    assert.equal(git('update-index', '--add', '--cacheinfo', `160000,${revision},nested-repository`).status, 0);
    const result = verify(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tracked submodules are not allowed/);
  });
});

async function stagedCopies(root) {
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  await writeFile(join(root, 'README.md'), '@' + brand + '/webrtc-sdk');
  await mkdir(join(root, 'izuanke-samples/scripts'), { recursive: true });
  await copyFile(verifier, join(root, 'izuanke-samples/scripts/verify-parity.mjs'));
  await writeFile(join(root, 'izuanke-samples/README.md'), '@' + 'izuanke/webrtc-sdk');
  await writeFile(join(root, 'example.js'), 'old');
  await writeFile(join(root, 'izuanke-samples/example.js'), 'old');
  assert.equal(git('add', 'README.md', 'scripts', 'example.js', 'izuanke-samples').status, 0);
  assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture').status, 0);
  return git;
}

test('staged parity detects an unstaged counterpart even when working files match', async () => {
  await fixture(async root => {
    const git = await stagedCopies(root);
    await writeFile(join(root, 'example.js'), 'new');
    await writeFile(join(root, 'izuanke-samples/example.js'), 'new');
    assert.equal(git('add', 'example.js').status, 0);
    assert.equal(verify(root).status, 0);
    const mismatch = verify(root, '--staged');
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /sample mismatch: example\.js/);
    assert.equal(git('add', 'izuanke-samples/example.js').status, 0);
    assert.equal(verify(root, '--staged').status, 0);
  });
});

test('staged parity detects a deletion staged in only one copy', async () => {
  await fixture(async root => {
    const git = await stagedCopies(root);
    await rm(join(root, 'example.js'));
    await rm(join(root, 'izuanke-samples/example.js'));
    assert.equal(git('add', '-u', 'example.js').status, 0);
    assert.equal(verify(root).status, 0);
    const mismatch = verify(root, '--staged');
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /sample file lists must match/);
    assert.equal(git('add', '-u', 'izuanke-samples/example.js').status, 0);
    assert.equal(verify(root, '--staged').status, 0);
  });
});

test('staged parity reads the index even when a copy is absent from the working tree', async () => {
  await fixture(async root => {
    await stagedCopies(root);
    await rm(join(root, 'izuanke-samples'), { recursive: true, force: true });
    assert.equal(verify(root, '--staged').status, 0);
  });
});

test('staged parity requires a second staged copy', async () => {
  await fixture(async root => {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    await writeFile(join(root, 'README.md'), '@' + brand + '/webrtc-sdk');
    assert.equal(git('add', 'README.md').status, 0);
    const result = verify(root, '--staged');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /staged parity requires both sample copies/);
  });
});

test('staged parity detects historical brand paths until their deletion is staged', async () => {
  await fixture(async root => {
    const git = await stagedCopies(root);
    const old = brand + '-old.js';
    await writeFile(join(root, old), brand);
    assert.equal(git('add', old).status, 0);
    assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'old file').status, 0);
    await rm(join(root, old));
    assert.equal(verify(root).status, 0);
    const index = verify(root, '--staged');
    assert.notEqual(index.status, 0);
    assert.match(index.stderr, /brand in staged path/);
    assert.equal(git('add', '-u', old).status, 0);
    assert.equal(verify(root, '--staged').status, 0);
  });
});

test('staged parity works from the nested copy with --against', async () => {
  await fixture(async root => {
    await stagedCopies(root);
    const result = verify(join(root, 'izuanke-samples'), '--staged', '--against', root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test('staged parity detects a file mode change staged in only one copy', async () => {
  await fixture(async root => {
    const git = await stagedCopies(root);
    assert.equal(git('update-index', '--chmod=+x', 'example.js').status, 0);
    const result = verify(root, '--staged');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sample mode mismatch: example\.js/);
    assert.equal(git('update-index', '--chmod=+x', 'izuanke-samples/example.js').status, 0);
    assert.equal(verify(root, '--staged').status, 0);
  });
});

test('staged parity uses the staged README even if the working README changes', async () => {
  await fixture(async root => {
    await stagedCopies(root);
    await writeFile(join(root, 'README.md'), 'temporary work in progress');
    assert.equal(verify(root, '--staged').status, 0);
  });
});

test('staged parity treats an explicit copy path as a literal Git pathspec', async () => {
  await fixture(async root => {
    const git = await stagedCopies(root);
    assert.equal(git('--literal-pathspecs', 'mv', 'izuanke-samples', '[copy]').status, 0);
    const result = verify(root, '--staged', '--against', join(root, '[copy]'));
    assert.equal(result.status, 0, result.stderr);
  });
});

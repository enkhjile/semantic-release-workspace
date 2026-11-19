import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifyConditionsContext } from 'semantic-release';
import { serviceURL } from './npm-identity.js';
import type { PackagePlan } from './plan-types.js';
import type { Destination } from './publication-state.js';
import { withPythonToken } from './python-identity.js';
import { command, digest, releaseError } from './release-io.js';
import { record } from './workspace-files.js';

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
export function pythonDestination(value: unknown): Destination {
  const options = value === undefined ? {} : value;
  if (
    !record(options) ||
    options.trustedPublishing !== true ||
    (options.uploadUrl === undefined) !== (options.indexUrl === undefined)
  )
    return releaseError(
      'Python publishing requires python.trustedPublishing: true and a complete destination URL pair.',
      'EWORKSPACECONFIG',
    );
  const registry = new URL(
    serviceURL(options.uploadUrl ?? 'https://upload.pypi.org/legacy/'),
  );
  const index = new URL(
    serviceURL(options.indexUrl ?? 'https://pypi.org/simple/'),
  );
  const knownPair =
    (registry.href === 'https://upload.pypi.org/legacy/' &&
      index.href === 'https://pypi.org/simple/') ||
    (registry.href === 'https://test.pypi.org/legacy/' &&
      index.href === 'https://test.pypi.org/simple/');
  const localPair =
    ['127.0.0.1', 'localhost', '[::1]'].includes(registry.hostname) &&
    registry.origin === index.origin &&
    !registry.search &&
    !index.search &&
    index.pathname.endsWith('/');
  if (!knownPair && !localPair)
    return releaseError(
      'Invalid Python upload or simple index URL.',
      'EWORKSPACECONFIG',
    );
  return {
    ecosystem: 'python',
    registry: registry.href,
    index: index.href,
    pythonAuth: 'oidc',
  };
}

interface Descriptor {
  filename: string;
  sha256: string;
}
interface Distribution extends Descriptor {
  data: string;
}
interface Metadata {
  name: string;
  version: string;
  files: Descriptor[];
  sha256: string;
}
const invalid = () =>
  releaseError(
    'Invalid Python distribution set or package metadata.',
    'EWORKSPACEARTIFACT',
  );
function checkMetadata(value: unknown): Metadata {
  if (
    !record(value) ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Array.isArray(value.files) ||
    value.files.length !== 2
  )
    return invalid();
  const files = value.files.map((f: unknown) => {
    if (
      !record(f) ||
      typeof f.filename !== 'string' ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(f.filename) ||
      typeof f.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      return invalid();
    return { filename: f.filename, sha256: f.sha256 };
  });
  const prefix = `${normalize(value.name).replaceAll('-', '_')}-${value.version}`;
  if (
    !files.some((f) => f.filename === `${prefix}.tar.gz`) ||
    !files.some(
      ({ filename }) =>
        filename.startsWith(prefix) &&
        /^-(?:[0-9][A-Za-z0-9_]*-)?[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+\.whl$/.test(
          filename.slice(prefix.length),
        ),
    )
  )
    return invalid();
  return {
    name: value.name,
    version: value.version,
    sha256: value.sha256,
    files,
  };
}
function unpack(bytes: Buffer, meta: Metadata): Distribution[] {
  if (digest(bytes) !== meta.sha256) return invalid();
  let envelope: unknown;
  try {
    envelope = JSON.parse(bytes.toString());
  } catch {
    return invalid();
  }
  if (
    !record(envelope) ||
    envelope.schemaVersion !== 1 ||
    !Array.isArray(envelope.files) ||
    envelope.files.length !== 2
  )
    return invalid();
  return envelope.files.map((f: unknown, i: number) => {
    const descriptor = meta.files[i];
    if (
      !descriptor ||
      !record(f) ||
      f.filename !== descriptor.filename ||
      f.sha256 !== descriptor.sha256 ||
      typeof f.data !== 'string'
    )
      return invalid();
    const decoded = Buffer.from(f.data, 'base64');
    if (
      !decoded.length ||
      decoded.toString('base64') !== f.data ||
      digest(decoded) !== f.sha256
    )
      return invalid();
    return { ...descriptor, data: f.data };
  });
}
const inspect = `
from pathlib import Path
import sys, zipfile, tarfile, json
from email.parser import BytesParser
path = Path(sys.argv[1])
prefix = sys.argv[2]
if path.suffix == ".whl":
    with zipfile.ZipFile(path) as archive:
        [entry] = [x for x in archive.infolist() if x.filename == prefix + ".dist-info/METADATA"]
        assert entry.file_size <= 10485760
        data = archive.read(entry)
else:
    with tarfile.open(path, "r:gz") as archive:
        [entry] = [x for x in archive if x.name == prefix + "/PKG-INFO"]
        assert entry.isfile() and entry.size <= 10485760
        data = archive.extractfile(entry).read()
headers = BytesParser().parsebytes(data, headersonly=True)
[name] = headers.get_all("Name")
[version] = headers.get_all("Version")
print(json.dumps([name,version]))
`;
function toolEnvironment(
  env: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: directory,
    USERPROFILE: directory,
    SYSTEMROOT: env.SYSTEMROOT,
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory,
    UV_NO_CONFIG: '1',
    UV_NO_CACHE: '1',
    UV_PYTHON_DOWNLOADS: 'never',
  };
}
export async function validatePython(
  pkg: PackagePlan,
  bytes: Buffer,
  metadata: unknown,
) {
  const meta = checkMetadata(metadata);
  if (meta.name !== pkg.name || meta.version !== pkg.nextVersion)
    return invalid();
  const files = unpack(bytes, meta);
  const directory = await mkdtemp(join(tmpdir(), 'workspace-py-validate-'));
  try {
    for (const f of files) {
      const path = join(directory, f.filename);
      await writeFile(path, Buffer.from(f.data, 'base64'));
      const output = await command(
        { cwd: directory, env: toolEnvironment(process.env, directory) },
        'python3',
        [
          '-I',
          '-c',
          inspect,
          path,
          `${normalize(meta.name).replaceAll('-', '_')}-${meta.version}`,
        ],
      );
      const result: unknown = JSON.parse(output.toString());
      if (
        !Array.isArray(result) ||
        typeof result[0] !== 'string' ||
        normalize(result[0]) !== pkg.name ||
        result[1] !== meta.version
      )
        return invalid();
    }
  } catch {
    return invalid();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildPython(
  context: VerifyConditionsContext,
  pkg: PackagePlan,
  source: string,
  directory: string,
) {
  const out = join(directory, 'dist');
  await command(
    {
      cwd: join(source, pkg.path),
      env: toolEnvironment(context.env ?? process.env, directory),
    },
    'uv',
    ['build', '--no-sources', '--out-dir', out, '.'],
  );
  const files: Distribution[] = [];
  const entries = await readdir(out, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = entry.name;
    if (filename === '.gitignore') continue;
    if (!entry.isFile() || files.length === 2) return invalid();
    const content = await readFile(join(out, filename));
    files.push({
      filename,
      sha256: digest(content),
      data: content.toString('base64'),
    });
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, files }));
  const metadata = {
    name: pkg.name,
    version: pkg.nextVersion,
    sha256: digest(bytes),
    files: files.map(({ filename, sha256 }) => ({ filename, sha256 })),
  };
  await validatePython(pkg, bytes, metadata);
  return { bytes, metadata };
}

// Only versions equivalent to a supported plan can conflict. Nonzero epochs,
// post/dev releases and local versions can never equal those plans.
function registryVersion(value: string): string | undefined {
  const match =
    /^v?(?:0+!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?$/i.exec(
      value,
    );
  if (!match?.[1]) return undefined;
  const release = match[1].split('.').map((n) => n.replace(/^0+(?=\d)/, ''));
  while (release.length > 1 && release.at(-1) === '0') release.pop();
  const label = match[2]?.toLowerCase();
  if (!label) return release.join('.');
  const stage = label.startsWith('a')
    ? 'a'
    : label.startsWith('b')
      ? 'b'
      : 'rc';
  return release.join('.') + stage + (match[3] || '0').replace(/^0+(?=\d)/, '');
}

async function missing(
  dest: Destination,
  name: string,
  version: string,
  meta?: Metadata,
) {
  const response = await fetch(
    new URL(`${encodeURIComponent(name)}/`, dest.index),
    {
      headers: {
        accept: 'application/vnd.pypi.simple.v1+json',
        'cache-control': 'no-cache',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status === 404) return meta?.files ?? [];
  if (!response.ok) return releaseError('Python simple index query failed.');
  const result: unknown = await response.json();
  if (!record(result) || !Array.isArray(result.files))
    return releaseError('Invalid Python simple index response.');
  const absent = new Map(meta?.files.map((f) => [f.filename, f]));
  const plannedVersion = registryVersion(version);
  for (const f of result.files) {
    if (!record(f) || typeof f.filename !== 'string')
      return releaseError('Invalid Python simple index file.');
    // Indexes may contain older sdists whose project component includes dashes.
    // Match PEP 440-equivalent versions before requiring the exact frozen filename.
    const split = f.filename.endsWith('.whl')
      ? f.filename.split('-').slice(0, 2)
      : new RegExp(
          `^(${name.split('-').join('[-_.]+')})-(.+)\\.(?:tar\\.gz|zip)$`,
          'i',
        )
          .exec(f.filename)
          ?.slice(1);
    if (
      !split?.[0] ||
      !split[1] ||
      normalize(split[0]) !== name ||
      registryVersion(split[1]) !== plannedVersion
    )
      continue;
    const planned = meta?.files.find((entry) => entry.filename === f.filename);
    if (!planned || !record(f.hashes) || f.hashes.sha256 !== planned.sha256)
      return releaseError(
        'Python registry version conflicts with retained files.',
        'EWORKSPACECONFLICT',
      );
    absent.delete(f.filename);
  }
  return [...absent.values()];
}
export async function probePython(
  dest: Destination,
  pkg: PackagePlan,
  metadata?: unknown,
) {
  const meta = metadata === undefined ? undefined : checkMetadata(metadata);
  const absent = await missing(dest, pkg.name, pkg.nextVersion ?? '', meta);
  return meta && !absent.length ? meta.sha256 : null;
}
export async function uploadPython(
  context: VerifyConditionsContext,
  dest: Destination,
  bytes: Buffer,
  metadata: unknown,
) {
  const meta = checkMetadata(metadata);
  const files = unpack(bytes, meta);
  const absent = await missing(dest, meta.name, meta.version, meta);
  if (!absent.length) return;
  const directory = await mkdtemp(join(tmpdir(), 'workspace-uv-publish-'));
  const env = context.env ?? process.env;
  try {
    const paths: string[] = [];
    for (const file of files) {
      if (!absent.some(({ filename }) => filename === file.filename)) continue;
      const path = join(directory, file.filename);
      await writeFile(path, Buffer.from(file.data, 'base64'));
      paths.push(path);
    }
    await withPythonToken(dest.registry, env, async (token) => {
      await command(
        {
          cwd: directory,
          env: { ...toolEnvironment(env, directory), UV_PUBLISH_TOKEN: token },
        },
        'uv',
        [
          'publish',
          '--trusted-publishing',
          'never',
          '--keyring-provider',
          'disabled',
          '--no-attestations',
          '--publish-url',
          dest.registry,
          ...paths,
        ],
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

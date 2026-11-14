import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semanticRelease from 'semantic-release';

const [cwd, remote, settingsJson] = process.argv.slice(2);
const settings = JSON.parse(settingsJson);
const requests = [];
let logs = '';
const output = new Writable({
  write(chunk, _encoding, callback) {
    logs += chunk.toString();
    callback();
  },
});
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push({
    method: request.method,
    path: request.url,
    body: body && JSON.parse(body),
  });
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && request.url === '/repos/fixture/workspace') {
    response.end(
      JSON.stringify({
        permissions: { push: true },
        clone_url: repositoryUrl,
        full_name: 'fixture/workspace',
      }),
    );
  } else if (
    request.method === 'POST' &&
    request.url === '/repos/fixture/workspace/releases'
  ) {
    response.statusCode = settings.failGithub ? 422 : 201;
    response.end(
      JSON.stringify(
        settings.failGithub
          ? { message: 'Injected release rejection' }
          : {
              id: 1,
              html_url: `${apiUrl}/fixture/workspace/releases/1`,
              ...JSON.parse(body),
            },
      ),
    );
  } else {
    response.statusCode = 404;
    response.end(
      JSON.stringify({
        message: `Unexpected fixture request: ${request.method} ${request.url}`,
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
const repositoryUrl = `${apiUrl}/fixture/workspace.git`;
// Core's branch expansion invokes Git with process.env rather than context.env.
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: `url.${pathToFileURL(remote).href}.insteadOf`,
  GIT_CONFIG_VALUE_0: repositoryUrl,
});
try {
  const result = await semanticRelease(
    {
      branches: ['main', { name: 'alpha', prerelease: true }],
      repositoryUrl,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this placeholder.
      tagFormat: 'workspace-v${version}',
      ci: false,
      dryRun: settings.dryRun ?? false,
      plugins: [
        [
          fileURLToPath(new URL('../../dist/index.mjs', import.meta.url)),
          { publish: false, ...settings.pluginConfig },
        ],
        [
          fileURLToPath(import.meta.resolve('@semantic-release/github')),
          {
            githubApiUrl: apiUrl,
            successComment: false,
            failComment: false,
            failTitle: false,
            releasedLabels: false,
            addReleases: false,
          },
        ],
      ],
    },
    {
      cwd,
      env: {
        ...process.env,
        ...settings.env,
        GH_TOKEN: 'fixture-github-token',
      },
      stdout: output,
      stderr: output,
    },
  );
  console.log(`RESULT:${JSON.stringify({ ok: true, result, requests, logs })}`);
} catch (error) {
  console.log(
    `RESULT:${JSON.stringify({ ok: false, message: error.message, requests, logs })}`,
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

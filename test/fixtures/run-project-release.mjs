import { Writable } from 'node:stream';
import semanticRelease from 'semantic-release';
import config from '../../release.config.mjs';

const [cwd, repositoryUrl, dryRun] = process.argv.slice(2);
let logs = '';
const output = new Writable({
  write(chunk, _encoding, callback) {
    logs += chunk.toString();
    callback();
  },
});
try {
  const result = await semanticRelease(
    {
      ...config,
      repositoryUrl,
      ci: false,
      dryRun: dryRun === 'true',
      plugins: config.plugins.filter(
        (plugin) =>
          (Array.isArray(plugin) ? plugin[0] : plugin) !==
          '@semantic-release/github',
      ),
    },
    { cwd, env: process.env, stdout: output, stderr: output },
  );
  console.log(`RESULT:${JSON.stringify({ ok: true, result, logs })}`);
} catch (error) {
  console.log(
    `RESULT:${JSON.stringify({ ok: false, message: error.message, logs })}`,
  );
}

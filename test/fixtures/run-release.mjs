import { Writable } from 'node:stream';
import SemanticReleaseError from '@semantic-release/error';
import semanticRelease from 'semantic-release';

const [cwd, repositoryUrl, plugin, settingsJson] = process.argv.slice(2);
const settings = JSON.parse(settingsJson);
let logs = '';
const output = new Writable({
  write(chunk, _encoding, callback) {
    logs += chunk.toString();
    callback();
  },
});
const failure = {
  [settings.failure === 'prepare' || settings.failure === 'after-prepare'
    ? 'prepare'
    : 'publish']() {
    if (settings.failure)
      throw new SemanticReleaseError('Injected lifecycle failure', 'EINJECTED');
  },
};

try {
  const result = await semanticRelease(
    {
      branches: ['main'],
      repositoryUrl,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this placeholder.
      tagFormat: settings.tagFormat ?? 'workspace-v${version}',
      ci: false,
      dryRun: settings.dryRun ?? false,
      plugins:
        settings.failure === 'prepare'
          ? [failure, [plugin, settings.pluginConfig ?? {}]]
          : [[plugin, settings.pluginConfig ?? {}], failure],
    },
    { cwd, env: { ...process.env }, stdout: output, stderr: output },
  );
  console.log(`RESULT:${JSON.stringify({ ok: true, result, logs })}`);
} catch (error) {
  const errors = error.errors ?? [error];
  console.log(
    `RESULT:${JSON.stringify({
      ok: false,
      message: error.message,
      codes: errors.map((item) => item.code),
      logs,
    })}`,
  );
}

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chdir, cwd } from 'node:process'
import { test } from 'node:test'
import { loadEnv } from '../packages/env/src/index.ts'

// One test covers both endings of the helper: a diagnostic on stderr and a silent exit.
test('the SDK reports the helper diagnostic when the secret connection fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sct-env-'))
  const directory = cwd()
  const cli = process.env.SCT_CLI
  // The SDK starts the CLI with the fixed argument "_env" and no shell. Set SCT_CLI to the current
  // runtime, so that Bun or Node starts the "_env" file in the working directory as the helper.
  process.env.SCT_CLI = process.execPath
  chdir(root)
  t.after(async () => {
    chdir(directory)
    if (cli === undefined) delete process.env.SCT_CLI
    else process.env.SCT_CLI = cli
    await rm(root, { recursive: true, force: true })
  })

  await writeFile(join(root, '_env'), "process.stderr.write('Register this project folder in global.sct first.\\n')\nprocess.exitCode = 1\n")
  await assert.rejects(loadEnv(),
    /The global\.sct secret connection closed\. Register this project folder in global\.sct first\./)

  await writeFile(join(root, '_env'), 'process.exitCode = 0\n')
  await assert.rejects(loadEnv(),
    /The global\.sct secret connection closed\. Call loadEnv\(\) to connect again\./)
})

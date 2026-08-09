// Browser witness for the tracked CLI face. It serves the exact shipped HTML,
// runs the real local Aiko binary behind the same fixed job contract, and clicks
// through both the CLI and native-manifest paths. No Tauri/WebKit dependency is
// needed, so Linux CI can falsify the interface before packaging.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const html = await readFile(new URL('../public/console.html', import.meta.url));
const verbs = [
  { id: 'version', title: 'Version', description: 'Print the runtime version.', argv: ['version'], long_running: false },
];
const jobs = new Map();
let nextJob = 0;
const json = (response, value, status = 200) => {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  response.end(body);
};
const server = createServer(async (request, response) => {
  if (request.url === '/console') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
    response.end(html);
    return;
  }
  if (request.url === '/cli/verbs') return json(response, verbs.map(({ argv: _, ...verb }) => verb));
  if (request.url === '/cli/auth') return json(response, { signed_in: false, accounts: [] });
  if (request.url === '/native/v1/manifest') {
    try {
      const { stdout } = await exec('aiko', ['native', 'manifest']);
      return json(response, JSON.parse(stdout));
    } catch (error) {
      return json(response, { error: error.message }, 503);
    }
  }
  if (request.method === 'POST' && request.url === '/cli/run') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const selected = verbs.find((verb) => verb.id === JSON.parse(raw).verb);
    if (!selected) return json(response, { error: 'unknown verb' }, 400);
    const id = ++nextJob;
    const job = { id, verb: selected.id, output: '', done: false, exit_code: null };
    jobs.set(id, job);
    exec('aiko', selected.argv)
      .then(({ stdout, stderr }) => Object.assign(job, { output: stdout + stderr, done: true, exit_code: 0 }))
      .catch((error) => Object.assign(job, { output: `${error.stdout ?? ''}${error.stderr ?? error.message}`, done: true, exit_code: error.code ?? -1 }));
    return json(response, job);
  }
  const jobId = request.url?.match(/^\/cli\/jobs\/(\d+)$/)?.[1];
  if (jobId && jobs.has(Number(jobId))) return json(response, jobs.get(Number(jobId)));
  json(response, { error: 'not found' }, 404);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const executablePath = process.env.AIKO_CHROME
    ?? execFileSync('sh', ['-c', 'command -v google-chrome || command -v chromium || command -v chromium-browser'], { encoding: 'utf8' }).trim();
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage();
  await page.goto(`${origin}/console`, { waitUntil: 'domcontentloaded' });
  if ((await page.title()) !== 'Aiko Console') throw new Error('console title missing');
  await page.getByRole('button', { name: /Version/ }).click();
  await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'exit 0');
  const output = await page.locator('#output').textContent();
  if (!/^aiko \d/.test(output ?? '')) throw new Error(`version output not rendered: ${output}`);
  await page.getByRole('button', { name: 'Load live manifest' }).click();
  await page.waitForFunction(() => !document.querySelector('#native-output')?.hidden);
  const manifest = await page.locator('#native-output').textContent();
  if (!manifest?.includes('aiko.native.v1')) throw new Error('native manifest not rendered');
  console.log(`PASS  CLI Version rendered: ${output.trim()}`);
  console.log('PASS  native manifest rendered');
  console.log('console browser witness: PASS');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

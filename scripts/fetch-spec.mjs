// Downloads the published openapi.yaml into spec/openapi.yaml, verbatim. The
// spec-sync workflow runs it daily, and `npm run spec:update` by hand.
import { readFileSync, writeFileSync } from 'node:fs';

const url = process.env.JINSHUJU_OPENAPI_URL ?? 'https://jinshuju.net/api/v1/openapi.yaml';
const response = await fetch(url, { headers: { Accept: 'application/yaml, text/yaml, */*' } });
if (!response.ok) {
  console.error(`GET ${url} answered ${response.status}`);
  process.exit(1);
}
const text = await response.text();
// A login page or an error page answered with 200 must not replace the spec.
if (!text.startsWith('openapi:')) {
  console.error(`GET ${url} did not answer an OpenAPI document`);
  process.exit(1);
}
const file = new URL('../spec/openapi.yaml', import.meta.url);
let before;
try {
  before = readFileSync(file, 'utf8');
} catch {
  before = undefined;
}
if (before === text) {
  console.log(`spec/openapi.yaml already matches ${url} (${text.length} bytes)`);
  process.exit(0);
}
writeFileSync(file, text);
// The day it was fetched, kept beside it and read by the generator: a refusal
// the CLI makes against this copy names the day, so a copy that has fallen
// behind the API can be told from a payload that is wrong. Written only when
// the spec moved, so a day on which it did not opens no pull request.
writeFileSync(new URL('../spec/fetched-on', import.meta.url), `${new Date().toISOString().slice(0, 10)}\n`);
console.log(`spec/openapi.yaml updated from ${url} (${text.length} bytes)`);

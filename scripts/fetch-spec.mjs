// Downloads the published openapi.yaml into spec/openapi.yaml, verbatim. The
// spec-sync workflow runs it daily, and `npm run spec:update` by hand.
import { writeFileSync } from 'node:fs';

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
writeFileSync(new URL('../spec/openapi.yaml', import.meta.url), text);
console.log(`spec/openapi.yaml updated from ${url} (${text.length} bytes)`);

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig,
  setConfigValue,
  unsetConfigValue,
  saveAccessToken,
  saveOAuthConfig,
  clearCredential
} from './config.js';

test('loadConfig prefers cli options over env over config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');
  setConfigValue(configPath, 'host', 'https://file.example.com');
  setConfigValue(configPath, 'auth_host', 'https://account.file.example.com');

  const loaded = loadConfig({
    configPath,
    env: { JINSHUJU_HOST: 'https://env.example.com', JINSHUJU_AUTH_HOST: 'https://account.env.example.com' },
    cli: { host: 'https://cli.example.com' }
  });

  assert.equal(loaded.host, 'https://cli.example.com');
  assert.equal(loaded.authHost, 'https://account.env.example.com');
  assert.equal(loaded.sources.host, 'cli');
  assert.equal(loaded.sources.authHost, 'env');
  rmSync(dir, { recursive: true, force: true });
});

test('setConfigValue and unsetConfigValue persist json config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');

  setConfigValue(configPath, 'host', 'https://example.com');
  setConfigValue(configPath, 'client_id', 'cli');
  unsetConfigValue(configPath, 'client_id');

  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { host: 'https://example.com' });
  rmSync(dir, { recursive: true, force: true });
});

test('loadConfig uses the built-in production OAuth client id only for the production auth host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');

  let loaded = loadConfig({ configPath, env: {} });
  assert.equal(loaded.authHost, 'https://account.jinshuju.net');
  assert.equal(loaded.clientId, 'jinshuju_cli_public');
  assert.equal(loaded.sources.clientId, 'missing');

  loaded = loadConfig({
    configPath,
    env: { JINSHUJU_AUTH_HOST: 'https://account.cny.jinshuju.net' }
  });
  assert.equal(loaded.authHost, 'https://account.cny.jinshuju.net');
  assert.equal(loaded.clientId, undefined);

  rmSync(dir, { recursive: true, force: true });
});

test('OAuth config is saved, loaded, and cleared without disturbing the rest of the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');
  setConfigValue(configPath, 'host', 'https://example.com');
  saveOAuthConfig(configPath, {
    type: 'oauth',
    auth_host: 'https://account.example.com',
    client_id: 'cli-client',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: '2026-01-01T00:00:00.000Z',
    scope: 'public forms'
  });

  let loaded = loadConfig({ configPath, env: {} });
  assert.equal(loaded.auth?.access_token, 'access-token');
  assert.equal(loaded.clientId, 'cli-client');
  assert.equal(loaded.authHost, 'https://account.example.com');

  clearCredential(configPath);
  loaded = loadConfig({ configPath, env: {} });
  assert.equal(loaded.host, 'https://example.com');
  assert.equal(loaded.auth, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('a stored access token and an OAuth session take the same slot, and the environment outranks both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');
  const session = { type: 'oauth' as const, auth_host: 'https://a.example.com', client_id: 'c', access_token: 'o' };

  saveOAuthConfig(configPath, session);
  saveAccessToken(configPath, 'tok_file');
  let loaded = loadConfig({ configPath, env: {} });
  assert.equal(loaded.accessToken, 'tok_file');
  assert.equal(loaded.sources.accessToken, 'file');
  assert.equal(loaded.auth, undefined);

  loaded = loadConfig({ configPath, env: { JINSHUJU_ACCESS_TOKEN: 'tok_env' } });
  assert.equal(loaded.accessToken, 'tok_env');
  assert.equal(loaded.sources.accessToken, 'env');

  saveOAuthConfig(configPath, session);
  loaded = loadConfig({ configPath, env: {} });
  assert.equal(loaded.accessToken, undefined);
  assert.equal(loaded.auth?.access_token, 'o');
  rmSync(dir, { recursive: true, force: true });
});

test('credentials left at the top level of an old config are not read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ access_token: 'old', api_key: 'k', api_secret: 's' }));

  const loaded = loadConfig({ configPath, env: { JINSHUJU_API_KEY: 'k', JINSHUJU_API_SECRET: 's' } });
  assert.equal(loaded.accessToken, undefined);
  assert.equal(loaded.auth, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('a config file that is not JSON is named, rather than surfacing as a parse error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-broken-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{"host": "h",');
  assert.throws(
    () => loadConfig({ configPath, env: {} }),
    (error: Error) => {
      assert.match(error.message, /config\.json is not valid JSON/);
      assert.doesNotMatch(error.message, /^Unexpected/);
      return true;
    }
  );

  writeFileSync(configPath, '[]');
  assert.throws(() => loadConfig({ configPath, env: {} }), /should hold a JSON object/);
});

test('writing the config keeps it private and leaves no draft behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-mode-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, '{}\n', { mode: 0o644 });
  setConfigValue(configPath, 'host', 'h');

  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['config.json']);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).host, 'h');
});

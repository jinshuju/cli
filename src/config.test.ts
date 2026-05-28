import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, setConfigValue, unsetConfigValue, maskSecret, saveOAuthConfig, clearOAuthConfig } from './config.js';

test('loadConfig prefers cli options over env over config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');
  setConfigValue(configPath, 'api_key', 'file-key');
  setConfigValue(configPath, 'api_secret', 'file-secret');

  const loaded = loadConfig({
    configPath,
    env: { JINSHUJU_API_KEY: 'env-key', JINSHUJU_API_SECRET: 'env-secret' },
    cli: { apiKey: 'cli-key' }
  });

  assert.equal(loaded.apiKey, 'cli-key');
  assert.equal(loaded.apiSecret, 'env-secret');
  assert.equal(loaded.sources.apiKey, 'cli');
  assert.equal(loaded.sources.apiSecret, 'env');
  rmSync(dir, { recursive: true, force: true });
});

test('setConfigValue and unsetConfigValue persist json config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');

  setConfigValue(configPath, 'api_key', 'key-1');
  setConfigValue(configPath, 'api_secret', 'secret-1');
  unsetConfigValue(configPath, 'api_secret');

  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { api_key: 'key-1' });
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

test('OAuth config is saved, loaded, and cleared without disturbing API key credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsj-config-'));
  const configPath = join(dir, 'config.json');
  setConfigValue(configPath, 'api_key', 'key-1');
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

  clearOAuthConfig(configPath);
  loaded = loadConfig({ configPath, env: {} });
  assert.equal(loaded.apiKey, 'key-1');
  assert.equal(loaded.auth, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('maskSecret keeps short hint without exposing full value', () => {
  assert.equal(maskSecret('abcdef123456'), 'abcd…3456');
  assert.equal(maskSecret(undefined), undefined);
});

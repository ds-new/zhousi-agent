import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const fixtureEnv = {
  ...baseEnv,
  DIY_CONTROL_PLANE_IMAGE: 'example/control@sha256:' + '1'.repeat(64),
  DIY_DATA_PLANE_IMAGE: 'example/data@sha256:' + '2'.repeat(64),
  DIY_EVOLUTION_IMAGE: 'example/evolution@sha256:' + '3'.repeat(64),
  DATABASE_URL: 'postgres://example/control',
  DIY_PLATFORM_ADMIN_KEY: 'diy_pa_test-admin-' + 'a'.repeat(32),
  DIY_EVOLUTION_INTERNAL_TOKEN: 'test-evolution-' + 'b'.repeat(32),
  DIY_TENANT_SERVICES: '{}',
  DIY_TENANT_ID: 'tenant-fixture',
  DIY_RUNTIME_DATABASE_URL: 'postgres://example/customer',
  DIY_DATA_PLANE_INTERNAL_TOKEN: 'test-data-' + 'c'.repeat(32),
  DIY_SERVICE_ACCOUNT_TOKEN: 'diy_sa_test-control-' + 'd'.repeat(32),
  DIY_CONTROL_PLANE_URL: 'https://control.example',
};
for (const file of ['docker-compose.production.yml', 'docker-compose.customer.yml']) {
  const args = ['compose', '--env-file', '/dev/null', '-f', file, 'config', '--format', 'json'];
  const missing = spawnSync('docker', args, { encoding: 'utf8', env: baseEnv });
  assert.notEqual(missing.status, 0, `${file} must reject missing required settings`);
  const result = spawnSync('docker', args, { encoding: 'utf8', env: fixtureEnv });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  for (const [name, service] of Object.entries(config.services)) {
    assert.equal(service.read_only, true, name);
    assert.equal(service.user, '1000:1000', name);
    assert.ok(service.cap_drop.includes('ALL'), name);
    assert.equal(service.environment.DIY_ALLOW_INSECURE_DEV, 'false', name);
    for (const port of service.ports ?? []) assert.equal(port.host_ip, '127.0.0.1', name);
  }
  if (file === 'docker-compose.production.yml') {
    assert.equal(config.services['data-plane'], undefined);
    assert.equal(config.services['control-plane'].environment.DIY_SERVICE_ACCOUNT_TOKEN, undefined);
    assert.equal(config.services.evolution.ports, undefined);
  } else {
    assert.equal(config.services['control-plane'], undefined);
    assert.equal(config.services['data-plane'].environment.DIY_ALLOW_STDIO_MCP, 'false');
    assert.equal(config.services['data-plane'].environment.DIY_PLATFORM_ADMIN_KEY, undefined);
  }
}
console.log('Production Compose: missing-settings rejection, separate trust domains, local-only ports and container hardening verified.');

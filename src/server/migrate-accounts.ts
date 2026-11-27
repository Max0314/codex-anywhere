import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountSubjectPattern, writeAccountState, type AccountState } from './account-state.js';
import { DeviceRegistry } from './device-registry.js';

export function migrateAccounts(registryPath: string, owner: string) {
  if (!accountSubjectPattern.test(owner)) throw Error('owner_configuration_invalid');
  const directory = dirname(registryPath);
  const sourcePath = resolve(directory, 'owner-devices.v1.json');
  const target = resolve(directory, 'accounts.v2.json');
  const raw = readFileSync(sourcePath, 'utf8');
  const legacy = JSON.parse(raw) as AccountState;
  if (legacy.version !== 1 || legacy.ownerSub !== owner || !Array.isArray(legacy.devices) || !legacy.sessions)
    throw Error('owner_registry_invalid');
  const trust = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : '';
  const digest = createHash('sha256').update(JSON.stringify([raw, trust])).digest('hex');
  if (existsSync(target)) {
    const current = JSON.parse(readFileSync(target, 'utf8')) as AccountState;
    if (current.version !== 2 || current.ownerSub !== owner || current.migrationDigest !== digest)
      throw Error('account_migration_source_changed');
    return { migrated: false, devices: current.devices.length, sessions: Object.keys(current.sessions).length };
  }
  const approved = trust ? new DeviceRegistry(registryPath).listApproved() : [];
  const keys = new Set<string>();
  const routes = new Set<string>();
  const devices = legacy.devices.map(device => {
    const key = device.role + ':' + device.id;
    if (keys.has(key) || !['client', 'connector'].includes(device.role)) throw Error('account_device_conflict');
    keys.add(key);
    if (device.role === 'connector') {
      if (!device.routeId || routes.has(device.routeId) || !device.securityVersion) throw Error('account_device_conflict');
      routes.add(device.routeId);
    }
    const entry = approved.find(item => item.role === device.role && item.id === device.id);
    if (!device.revoked && approved.some(item => item.role === device.role &&
      (item.id === device.id || device.role === 'connector' && item.routeDeviceId === device.routeId) &&
      (item.id !== device.id || item.publicKey !== device.publicKey || item.routeDeviceId !== device.routeId)))
      throw Error('account_legacy_trust_conflict');
    return { ...device, label: entry?.label || device.label, sub: owner };
  });
  const sessions = Object.fromEntries(Object.entries(legacy.sessions).map(([key, value]) => {
    if (!/^[0-9a-f]{64}$/.test(key) || value.keyId && !keys.has('client:' + value.keyId))
      throw Error('account_legacy_session_invalid');
    return [key, { ...value, sub: owner }];
  }));
  writeAccountState(target, { version: 2, ownerSub: owner, devices, sessions, migrationDigest: digest });
  return { migrated: true, devices: devices.length, sessions: Object.keys(sessions).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(migrateAccounts(process.env.BRIDGE_DEVICE_REGISTRY_FILE || '/data/devices.json', process.env.OWNER_SUB || '')));
}

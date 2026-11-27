import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const accountSubjectPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type AccountDevice = {
  sub: string;
  role: 'client' | 'connector';
  id: string;
  publicKey: string;
  label: string;
  routeId?: string;
  revision: number;
  revoked: boolean;
  securityVersion?: string;
};

export type AccountState = {
  version: 1 | 2;
  ownerSub: string;
  devices: AccountDevice[];
  sessions: Record<string, { sub: string; keyId?: string; revoked: boolean }>;
  migrationDigest?: string;
};

export function writeAccountState(file: string, state: AccountState) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.tmp';
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

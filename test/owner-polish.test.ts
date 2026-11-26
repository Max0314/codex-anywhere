import assert from 'node:assert/strict';
import test from 'node:test';
import { hiddenInternalContext } from '../web/src/internal-context';
import { quotaWindows } from '../web/src/account-quota';
import { ownerAuthorizationCloseCode } from '../src/server/owner-access';
import { OwnerAccess } from '../src/server/owner-access';
import { DeviceRegistry } from '../src/server/device-registry';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('transient identity failures keep a retryable socket code while logout and revocation remain distinct', () => {
  assert.equal(ownerAuthorizationCloseCode(new Error('identity_timeout')), 1013);
  assert.equal(ownerAuthorizationCloseCode({status:503,message:'identity_unavailable'}), 1013);
  assert.equal(ownerAuthorizationCloseCode({status:401,message:'login_required'}), 4401);
  assert.equal(ownerAuthorizationCloseCode({status:403,message:'device_revoked'}), 4403);
  assert.equal(ownerAuthorizationCloseCode({status:403,message:'device_proof_invalid'}), 4407);
});

test('only standalone internal goal payloads without attachments are hidden', () => {
  const text = '<codex_internal_context source="goal">private execution rules</codex_internal_context>';
  assert.equal(hiddenInternalContext({kind:'user',text}), true);
  assert.equal(hiddenInternalContext({kind:'assistant',text}), false);
  assert.equal(hiddenInternalContext({kind:'user',text:'Example:\n'+text}), false);
  assert.equal(hiddenInternalContext({kind:'user',text:'```xml\n'+text+'\n```'}), false);
  assert.equal(hiddenInternalContext({kind:'user',text,visualization:{path:'/example'} as any}), false);
});

test('quota keeps real windows, ignores absent numbers and prefers the multi-bucket response', () => {
  const value = quotaWindows({rateLimits:{primary:{usedPercent:99,windowDurationMins:300}}, rateLimitsByLimitId:{codex:{primary:{usedPercent:18,windowDurationMins:10080,resetsAt:1796201275},secondary:null}}});
  assert.deepEqual(value,[{limitId:'codex',label:'Codex · 本周',remaining:82,resetsAt:1796201275}]);
  assert.deepEqual(quotaWindows({rateLimits:{primary:{windowDurationMins:300}}}),[]);
  assert.deepEqual(quotaWindows(null),[]);
});

test('an interrupted identity response rejects and the next check can recover', async () => {
  const saved = { ...process.env };
  const directory = mkdtempSync(join(tmpdir(), 'owner-response-'));
  let interrupt = true;
  const ownerSub = '11111111-1111-4111-8111-111111111111';
  const provider = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if(interrupt){ response.flushHeaders(); setTimeout(() => response.destroy(), 10); }
    else response.end(JSON.stringify({authenticated:true,sub:ownerSub}));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { PUBLIC_ORIGIN:'https://test.invalid', OWNER_SUB:ownerSub, IDENTITY_BASE_URL:'http://127.0.0.1:'+(provider.address() as any).port, FRIBENCH_CLIENT_SECRET:'a'.repeat(48), SESSION_BINDING_KEY:'b'.repeat(48) });
  try {
    const access = new OwnerAccess(new DeviceRegistry(join(directory,'devices.json')));
    const request = {headers:{cookie:'__Host-fribench_codex_anywhere=valid'}} as any;
    await assert.rejects(access.guard(request), /identity_/);
    interrupt = false;
    assert.ok((await access.guard(request)).key);
  } finally {
    process.env = saved;
    await new Promise<void>(resolve => provider.close(() => resolve()));
    rmSync(directory,{recursive:true,force:true});
  }
});

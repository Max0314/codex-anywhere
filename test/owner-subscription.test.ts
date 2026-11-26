import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorSecureChannels } from '../src/connector/secure-channels.js';
import { createDeviceIdentity } from '../src/shared/device-auth.js';

test('additional phones receive complete text snapshots while older selections cannot replace the current thread', () => {
  const frames: any[] = [];
  const channels = new ConnectorSecureChannels({ identity: createDeviceIdentity(), deviceId: 'pc', send: () => true, handleRequest: async () => ({}) });
  channels.sendEvent = frame => { frames.push(frame); return true; };
  channels.select('phone-a', 'thread', 1);
  channels.select('phone-b', 'thread', 2);
  channels.sendThreadEvent({ clientId: 'phone-a', event: 'turn.delta', payload: { threadId: 'thread', turnId: 'turn', itemId: 'reply', delta: 'Hello' } });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].clientId, 'phone-b');
  assert.equal(frames[0].event, 'thread.text-snapshot');
  assert.equal(frames[0].payload.fullText, 'Hello');
  channels.sendThreadEvent({ clientId: 'phone-a', event: 'turn.delta', payload: { threadId: 'thread', turnId: 'turn', itemId: 'reply', delta: ' world' } });
  assert.equal(frames[1].payload.fullText, 'Hello world');
  assert.ok(frames[1].seq > frames[0].seq);
  assert.equal(channels.select('phone-b', 'other', 3), true);
  assert.equal(channels.select('phone-b', 'thread', 2), false);
  channels.sendThreadEvent({ clientId: 'phone-a', event: 'turn.ended', payload: { threadId: 'thread', turnId: 'turn' } });
  assert.equal(frames.length, 2);
});

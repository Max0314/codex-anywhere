import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { saveImageAttachment } from '../src/connector/attachments.js';
import { DownloadManager } from '../src/connector/file-downloads.js';
import { readThreadFamily } from '../src/connector/thread-family.js';
import { followUpDraft } from '../web/src/follow-up-draft';
import { resolveAllowedWorkspace } from '../src/connector/workspace-policy.js';

test('owner can recover an old conversation upload and download the same original outside legacy roots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-history-'));
  const previous = process.env.BRIDGE_OWNER_MODE;
  process.env.BRIDGE_OWNER_MODE = '1';
  t.after(async () => { if (previous === undefined) delete process.env.BRIDGE_OWNER_MODE; else process.env.BRIDGE_OWNER_MODE=previous;
    await rm(directory, { recursive: true, force: true }); });
  const bytes = await readFile(new URL('../web/public/icons/icon-180.png', import.meta.url));
  const image = { mimeType: 'image/png', size: bytes.length, data: bytes.toString('base64') };
  const first = await saveImageAttachment(image, { directory });
  await utimes(first.path, 1, 1);
  await saveImageAttachment(image, { directory });
  assert.equal(resolveAllowedWorkspace(null, directory), directory);
  const manager = new DownloadManager({ allowedRoots: [], allowAnyFileDownload: true, auditPath: null });
  t.after(() => manager.closeAll());
  const opened = await manager.open({ path: first.path, confirmed:true }, 'phone');
  const chunk = await manager.read({ ...opened, offset: 0 }, 'phone');
  assert.deepEqual(Buffer.from(chunk.data, 'base64'), bytes);
});

test('subagent navigation reads only the selected family and works in both directions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-family-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  assert.equal(await readThreadFamily('parent', directory), null);
  const db = new DatabaseSync(join(directory, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT, agent_nickname TEXT, title TEXT, created_at INTEGER);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES ('p',NULL,'Parent',0),('c','Reviewer','Child',1),('u',NULL,'Unrelated',2);
    INSERT INTO thread_spawn_edges VALUES ('p','c');`);
  db.close();
  assert.deepEqual(structuredClone(await readThreadFamily('p', directory)), { parent:null, children:[{ id:'c', title:'Reviewer' }] });
  assert.deepEqual(structuredClone(await readThreadFamily('c', directory)), { parent:{ id:'p',title:'Parent' }, children:[] });
});

test('suggestions use the latest reply, leave code alone and never carry past a new user turn', () => {
  const reply = { id:'a', kind:'assistant' as const, text:'已完成。下一步建议核对安装版本。' };
  assert.equal(followUpDraft([reply]), '请核对安装版本。');
  assert.equal(followUpDraft([reply, { id:'u', kind:'user', text:'换个问题' }]), '');
  assert.equal(followUpDraft([{ ...reply, text:'```text\n下一步建议删除目录。\n```' }]), '');
});

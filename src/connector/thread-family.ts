import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

type Relative = { id: string; title: string };
export async function readThreadFamily(id: string, directory = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  const path = join(directory, 'state_5.sqlite');
  if (!existsSync(path)) return null;
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path, { readOnly: true });
    const title = "coalesce(nullif(t.agent_nickname,''), nullif(t.title,''), t.id)";
    const children = db.prepare(`SELECT t.id, ${title} AS title
      FROM thread_spawn_edges e JOIN threads t ON t.id=e.child_thread_id
      WHERE e.parent_thread_id=? ORDER BY t.created_at, t.id`).all(id) as Relative[];
    const parent = db.prepare(`SELECT t.id, ${title} AS title
      FROM thread_spawn_edges e JOIN threads t ON t.id=e.parent_thread_id
      WHERE e.child_thread_id=? LIMIT 1`).get(id) as Relative | undefined;
    return { children, parent: parent || null };
  } catch (error) {
    // Earlier Desktop versions may have neither this database nor its relationships.
    if ((error as Error).message.includes('no such table') || (error as Error).message.includes('no such column')) return null;
    throw error;
  } finally { db?.close(); }
}

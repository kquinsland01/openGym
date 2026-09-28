// Offline only. This process does not import server.js or write any application data.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, validateDb, validateState } from '../storage-read.js';
const dir = process.argv[2];
if (!dir) throw new Error('Usage: node api/scripts/validate-storage.js /path/to/restored/data');
const db = readJson(path.join(dir, 'db.json'), validateDb);
if (!db) throw new Error('Restored database is missing; refusing to approve an empty installation');
let profiles = 0;
for (const name of fs.readdirSync(dir)) {
  if (/^state-[a-zA-Z0-9_-]+\.json$/.test(name)) { readJson(path.join(dir, name), validateState); profiles++; }
}
console.log(`Database and ${profiles} existing profiles passed structural validation. This does not validate media, Coach credentials or backup completeness.`);

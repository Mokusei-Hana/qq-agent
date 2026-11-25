import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { digest, canonical, fail } from './integrity.js';
const SQL = fs.readFileSync(fileURLToPath(new URL('../../migrations/personality-evolution/001.sql', import.meta.url)), 'utf8');
const COLUMNS = {
 personality_observations: ['id','group_id','response_id','source_key','category','pattern_key','feature_data','created_at'],
 personality_habits: ['id','scope_type','scope_id','category','habit_key','usage_context','confidence','evidence_count','source_count','status','first_seen_at','last_seen_at','updated_at'],
 personality_feedback: ['id','group_id','response_id','feedback_type','score','source','created_at'],
 personality_versions: ['id','content','change_summary','source_habit_ids','created_at','created_by','previous_version'],
 personality_state: ['key','value']
};
export const legacyTables = Object.freeze(Object.keys(COLUMNS));
export const migrationHash = digest(SQL);
export function legacyDigest(db) {
 return digest(Object.fromEntries(legacyTables.map(t => [t, db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()])));
}
export function configure(db) {
 db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA busy_timeout=10; PRAGMA synchronous=FULL;');
}
export function validateLegacy(db) {
 if (db.prepare('PRAGMA user_version').get().user_version !== 1) fail('LEGACY_SCHEMA_VERSION');
 for (const [table, columns] of Object.entries(COLUMNS)) {
  const info = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (canonical(info.map(r => r.name)) !== canonical(columns)) fail('LEGACY_COLUMNS_' + table);
  const pk = info.find(r => r.pk === 1);
  if (!pk || pk.name !== (table === 'personality_state' ? 'key' : 'id')) fail('LEGACY_PRIMARY_KEY');
  for (const col of info) {
   const expected = col.name === 'confidence' ? 'REAL' :
    ['id','score','evidence_count','source_count','first_seen_at','last_seen_at','updated_at','created_at','previous_version'].includes(col.name) && !(table === 'personality_habits' && col.name === 'id') ? 'INTEGER' : 'TEXT';
   if (col.type !== expected) fail('LEGACY_TYPE_' + table + '_' + col.name);
  }
  if (db.prepare('PRAGMA foreign_key_list(' + table + ')').all().length) fail('UNEXPECTED_LEGACY_FOREIGN_KEY');
 }
 const versions = db.prepare('SELECT * FROM personality_versions').all();
 if (versions.length !== 1 || versions[0].id !== 0 || versions[0].content !== '[]' || versions[0].created_by !== 'initial' ||
  db.prepare("SELECT value FROM personality_state WHERE key='version'").get()?.value !== '0' ||
  db.prepare("SELECT count(*) AS n FROM personality_habits WHERE status='active'").get().n) fail('BASELINE_REQUIRES_MANUAL_REVIEW');
}
export function migrate(file, { now = Date.now(), beforeCommit = null } = {}) {
 if (!fs.existsSync(file)) fail('EXISTING_DATABASE_REQUIRED');
 if (!Number.isSafeInteger(now)) fail('INVALID_MIGRATION_TIME');
 const db = new DatabaseSync(file);
 try {
  configure(db);
  const present = db.prepare("SELECT 1 FROM sqlite_master WHERE name='pe_schema'").get();
  if (present) {
   if (db.prepare('SELECT migration_hash FROM pe_schema WHERE version=1').get()?.migration_hash !== migrationHash) fail('MIGRATION_HASH_MISMATCH');
   for (const [, name] of SQL.matchAll(/CREATE (?:TABLE|TRIGGER|(?:UNIQUE )?INDEX)\s+(\w+)/g))
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name)) fail('MISSING_MIGRATED_OBJECT_' + name);
   return { migrated: false, hash: migrationHash };
  }
  validateLegacy(db);
  const before = legacyDigest(db);
  const body = SQL.replace(':migration_hash', "'" + migrationHash + "'").replace(':applied_at', String(now)).replace(/COMMIT;\s*$/, '');
  try {
   db.exec(body);
   if (db.prepare('PRAGMA foreign_key_check').all().length) fail('FOREIGN_KEY_CHECK');
   if (legacyDigest(db) !== before) fail('LEGACY_DATA_CHANGED');
   beforeCommit?.(db);
   db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return { migrated: true, hash: migrationHash, legacyHash: before };
 } finally { db.close(); }
}
export function assertIsolatedPath(file) {
 const root = process.env.PE_WORKSPACE_ROOT;
 if (!root || !fs.realpathSync(path.dirname(file)).startsWith(fs.realpathSync(root) + path.sep)) fail('ISOLATED_PATH_REQUIRED');
}

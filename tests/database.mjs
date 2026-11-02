import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create schema auth;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
let schema=fs.readFileSync(new URL('supabase/schema.sql', root),'utf8');
schema=schema.slice(0,schema.lastIndexOf('do $$'));
await db.exec(schema);
const migration=fs.readFileSync(new URL('supabase/timetable.sql', root),'utf8');
await db.exec(migration);await db.exec(migration);
console.log('Schema and migration applied twice successfully');
await db.exec(`begin;
insert into auth.users values ('00000000-0000-0000-0000-000000000001','test@example.com','{"nickname":"test"}');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
insert into public.course_meetings
(semester,campus,course_code,section,course_name,weekday,starts_at,ends_at,valid_from,valid_until,source_url)
select 'test','서울','TEST','01','수업',extract(isodow from now() at time zone 'Asia/Seoul'),
 (now() at time zone 'Asia/Seoul')::time,
 ((now() at time zone 'Asia/Seoul')::time + interval '1 minute'),
 (now() at time zone 'Asia/Seoul')::date,(now() at time zone 'Asia/Seoul')::date,'https://sugang.korea.ac.kr';
insert into public.course_meetings
(semester,campus,course_code,section,course_name,weekday,starts_at,ends_at,valid_from,valid_until,source_url)
select 'test','서울','TEST','02','시작 경계',extract(isodow from now() at time zone 'Asia/Seoul'),
 ((now() at time zone 'Asia/Seoul')::time + interval '10 minutes'),
 ((now() at time zone 'Asia/Seoul')::time + interval '11 minutes'),
 (now() at time zone 'Asia/Seoul')::date,(now() at time zone 'Asia/Seoul')::date,'https://sugang.korea.ac.kr';
insert into public.course_meetings
(semester,campus,course_code,section,course_name,weekday,starts_at,ends_at,valid_from,valid_until,source_url)
select 'test','서울','TEST','03','종료 경계',extract(isodow from now() at time zone 'Asia/Seoul'),
 ((now() at time zone 'Asia/Seoul')::time - interval '1 minute'),
 (now() at time zone 'Asia/Seoul')::time,
 (now() at time zone 'Asia/Seoul')::date,(now() at time zone 'Asia/Seoul')::date,'https://sugang.korea.ac.kr';`);
assert.equal((await db.query('select * from public.current_course_meetings()')).rows.length,2);
await db.exec("set role authenticated");
assert.equal((await db.query('select * from public.current_course_meetings()')).rows.length,2);
const result=(await db.query("select public.submit_scheduled_code(1,'0123',10) as result")).rows[0].result;
assert.equal(result.code,'0123');
assert.equal(result.stats.uploaded,1);
async function rejected(sql, pattern) {
  await db.exec('savepoint rejected');
  try { await assert.rejects(db.query(sql),pattern); }
  finally { await db.exec('rollback to savepoint rejected'); }
}
await rejected("select public.submit_scheduled_code(1,'0123',10)",/아직 유효/);
await rejected("select public.submit_scheduled_code(3,'0123',10)",/선택 가능한/);
await rejected("select public.submit_scheduled_code(999999,'0123',10)",/선택 가능한/);
await rejected("select public.submit_code('fake','0123',10)",/permission denied/);
await rejected("select * from public.course_meetings",/permission denied/);
await db.exec('reset role');
assert.equal((await db.query('select meeting_id from public.codes')).rows[0].meeting_id,1);
await db.exec(`update public.course_meetings set excluded_dates=array[(now() at time zone 'Asia/Seoul')::date] where id=2`);
assert.equal((await db.query('select * from public.current_course_meetings()')).rows.length,1);
await db.exec("select set_config('request.jwt.claim.sub','',true)");
assert.equal((await db.query('select * from public.current_course_meetings()')).rows.length,0);
await rejected("select public.submit_scheduled_code(1,'0123',10)",/로그인이 필요/);
await db.exec('rollback');
console.log('PASS: timing boundaries, distinct sections, credits, duplicates, forged IDs, permissions, holidays, anonymous requests');
await db.close();

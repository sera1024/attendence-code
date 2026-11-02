-- Apply schema.sql first, then this migration. No production course data is seeded.
begin;
create table if not exists public.course_meetings (
  id bigint generated always as identity primary key,
  semester text not null check (char_length(semester) between 1 and 20),
  campus text not null check (campus in ('서울','세종')),
  course_code text not null check (char_length(course_code) between 1 and 20),
  section text not null check (char_length(section) between 1 and 10),
  course_name text not null check (char_length(course_name) between 1 and 100),
  instructor text not null default '',
  weekday smallint not null check (weekday between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  valid_from date not null,
  valid_until date not null,
  excluded_dates date[] not null default '{}',
  enabled boolean not null default true,
  source_url text not null,
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (valid_until >= valid_from),
  unique (semester,campus,course_code,section,weekday,starts_at)
);
alter table public.course_meetings enable row level security;
revoke all on public.course_meetings from anon, authenticated;
-- Only trusted operators import or modify the catalog through SQL Editor.
alter table public.codes add column if not exists meeting_id bigint references public.course_meetings(id);
alter table public.codes drop constraint if exists codes_course_check;
alter table public.codes add constraint codes_course_check check (char_length(course) between 1 and 200);

create or replace function public.current_course_meetings()
returns setof public.course_meetings
language sql stable security definer set search_path = ''
as $$
  select m.* from public.course_meetings m
  where auth.uid() is not null and m.enabled
    and (now() at time zone 'Asia/Seoul')::date between m.valid_from and m.valid_until
    and not ((now() at time zone 'Asia/Seoul')::date = any(m.excluded_dates))
    and extract(isodow from now() at time zone 'Asia/Seoul') = m.weekday
    and now() at time zone 'Asia/Seoul' >=
        (now() at time zone 'Asia/Seoul')::date + m.starts_at - interval '10 minutes'
    and now() at time zone 'Asia/Seoul' <
        (now() at time zone 'Asia/Seoul')::date + m.ends_at
  order by m.starts_at, m.campus, m.course_code, m.section;
$$;

create or replace function public.submit_scheduled_code(p_meeting_id bigint, p_code text, p_minutes integer default 10)
returns json language plpgsql security definer set search_path = ''
as $$
declare
  m public.course_meetings;
  result json;
  label text;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다.' using errcode='28000'; end if;
  -- Authoritative time and eligibility check; client clock and dropdown cannot bypass it.
  select * into m from public.current_course_meetings() where id = p_meeting_id;
  if not found then
    raise exception '현재 선택 가능한 수업이 아닙니다. 시간표를 새로고침해 주세요.' using errcode='22023';
  end if;
  label := m.semester || ' ' || m.campus || ' ' ||
    case when m.course_code like 'HWP-%' then
      m.course_name || ' (' || m.instructor || ') ' ||
      case when m.section = '-' then '분반 미표기' else m.section || '분반' end
    else m.course_code || '-' || m.section || ' ' || m.course_name end;
  result := public.submit_code(label, p_code, p_minutes);
  update public.codes set meeting_id = m.id where id = (result->>'id')::bigint;
  return result;
end;
$$;
revoke all on function public.current_course_meetings() from public, anon;
revoke all on function public.submit_scheduled_code(bigint,text,integer) from public, anon;
grant execute on function public.current_course_meetings() to authenticated;
grant execute on function public.submit_scheduled_code(bigint,text,integer) to authenticated;
-- Remove direct free-text submission; wrapper can still call this as owner.
revoke all on function public.submit_code(text,text,integer) from public, anon, authenticated;

create or replace function public.submit_code(p_course text, p_code text, p_minutes integer default 10)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid    := auth.uid();
  v_course  text    := btrim(regexp_replace(coalesce(p_course, ''), '\s+', ' ', 'g'));
  v_code    text    := btrim(coalesce(p_code, ''));
  v_minutes integer := least(greatest(coalesce(p_minutes, 10), 1), 10);
  v_nick    text;
  v_row     public.codes;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '28000';
  end if;
  if v_code !~ '^[0-9]{4}$' then
    raise exception '출석 코드는 숫자 4자리여야 합니다.' using errcode = '22023';
  end if;
  if char_length(v_course) not between 1 and 200 then
    raise exception '과목명은 1~200자로 입력해 주세요.' using errcode = '22023';
  end if;

  -- 같은 사용자의 동시 요청 직렬화 (프로필 행 잠금)
  select nickname into v_nick from public.profiles where id = v_uid for update;
  if v_nick is null then
    raise exception '프로필이 없습니다. 다시 로그인해 주세요.' using errcode = 'P0002';
  end if;

  -- 열람권 부풀리기 방지: 같은 과목에 아직 유효한 내 코드가 있으면 거절
  if exists (select 1 from public.codes
              where uploader_id = v_uid
                and course = v_course
                and expires_at > now()) then
    raise exception '이 과목에 올린 코드가 아직 유효해요. 만료된 뒤에 다시 올릴 수 있어요.'
      using errcode = 'P0001';
  end if;

  insert into public.codes (course, uploader_id, uploader_nickname, expires_at)
  values (v_course, v_uid, v_nick, now() + make_interval(mins => v_minutes))
  returning * into v_row;

  insert into public.code_secrets (code_id, code) values (v_row.id, v_code);

  return json_build_object(
    'id',         v_row.id,
    'code',       v_code,
    'expires_at', v_row.expires_at,
    'stats',      public.my_stats());
end;
$$;


commit;

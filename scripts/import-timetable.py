"""Validate operator-reviewed KU timetable CSV and emit an atomic SQL upsert.
No network calls, credentials, guessed period conversions or DB writes.
"""
import argparse
import csv
import datetime as dt
import io
from pathlib import Path

FIELDS = ['semester','campus','course_code','section','course_name','instructor',
          'weekday','starts_at','ends_at','valid_from','valid_until','source_url']
LIMITS = {'semester':20,'course_code':20,'section':10,'course_name':100}
DAYS = {d: str(i+1) for i,d in enumerate('월화수목금토일')}

def quote(s):
    return "'" + s.replace("'", "''") + "'"

def convert(text):
    reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
    if not reader.fieldnames or not set(FIELDS) <= set(reader.fieldnames):
        raise ValueError('Required columns: ' + ','.join(FIELDS))
    statements = []
    seen = set()
    for line, raw in enumerate(reader, 2):
        r = {k: (raw.get(k) or '').strip() for k in FIELDS}
        try:
            for k, limit in LIMITS.items():
                if not 1 <= len(r[k]) <= limit: raise ValueError('Invalid '+k)
            if r['campus'] not in ('서울','세종'): raise ValueError('Invalid campus')
            r['weekday'] = DAYS.get(r['weekday'], r['weekday'])
            if r['weekday'] not in map(str, range(1,8)): raise ValueError('Invalid weekday')
            for k in ('starts_at','ends_at'):
                # Explicit clock times only. "1-2교시" must be converted using the official period table.
                import re
                if not re.fullmatch(r'\d{2}:\d{2}', r[k]): raise ValueError('Use HH:MM: '+k)
                dt.time.fromisoformat(r[k])
            if r['ends_at'] <= r['starts_at']: raise ValueError('End must be after start')
            first, last = (dt.date.fromisoformat(r[k]) for k in ('valid_from','valid_until'))
            if first > last: raise ValueError('Invalid semester dates')
            from urllib.parse import urlparse
            u = urlparse(r['source_url'])
            if u.scheme != 'https' or not (u.hostname or '').endswith('.korea.ac.kr'):
                raise ValueError('Provide official Korea University source URL')
            key = tuple(r[k] for k in ('semester','campus','course_code','section','weekday','starts_at'))
            if key in seen: raise ValueError('Duplicate meeting')
            seen.add(key)
            if any('\x00' in v for v in r.values()): raise ValueError('NUL in input')
        except ValueError as e:
            raise ValueError(f'CSV line {line}: {e}') from e
        values = ','.join(quote(r[k]) for k in FIELDS)
        updates = ','.join(f'{k}=excluded.{k}' for k in ('course_name','instructor','ends_at','valid_from','valid_until','source_url'))
        statements.append(f"insert into public.course_meetings ({','.join(FIELDS)}) values ({values}) "
                          f"on conflict (semester,campus,course_code,section,weekday,starts_at) do update set {updates},updated_at=now();")
    if not statements: raise ValueError('No timetable rows; nothing was generated')
    return "begin;\nset standard_conforming_strings = on;\n" + '\n'.join(statements) + '\ncommit;\n'

if __name__ == '__main__':
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('csv_file'); ap.add_argument('sql_file')
    args=ap.parse_args()
    # Validate whole input before touching output.
    sql=convert(Path(args.csv_file).read_text(encoding='utf-8-sig'))
    Path(args.sql_file).write_text(sql,encoding='utf-8')

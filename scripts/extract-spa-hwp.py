"""Extract the uploaded KU SPA 2026-2 timetable. Requires: pip install olefile.
This is a deliberately document-specific parser: validates the 11x6 table and
its own period labels rather than guessing another HWP's layout.
"""
import csv
import hashlib
import io
import json
import re
import struct
import zlib
from pathlib import Path

SOURCE='https://spa.korea.ac.kr/spa/4479/subview.do?enc=Zm5jdDF8QEB8JTJGYmJzJTJGc3BhJTJGMTQ5JTJGMjcxNDM4JTJGYXJ0Y2xWaWV3LmRvJTNG'
CALENDAR='https://digb.korea.ac.kr/dhe/14117/subview.do'
HOLIDAYS=['2026-09-24','2026-09-25','2026-09-26','2026-10-03','2026-10-05','2026-10-09']
FIELDS=['semester','campus','course_code','section','course_name','instructor','weekday','starts_at','ends_at','valid_from','valid_until','source_url']

def text(payload):
    units=list(struct.unpack('<'+'H'*(len(payload)//2),payload));out=[];i=0
    while i<len(units):
        c=units[i]
        if c in (1,2,3,11,12,14,15,16,17,18,21,22,23):i+=8;continue
        if c==9:out.append(9);i+=8;continue
        if c>=32 or c in (10,13):out.append(c)
        i+=1
    return struct.pack('<'+'H'*len(out),*out).decode('utf-16le').strip()

def extract(path):
    import olefile
    raw=Path(path).read_bytes()
    with olefile.OleFileIO(io.BytesIO(raw)) as doc:
        header=doc.openstream('FileHeader').read()
        flags=struct.unpack_from('<I',header,36)[0]
        if flags & 2:raise ValueError('Encrypted HWP is unsupported')
        if [n for n in doc.listdir() if n[0]=='BodyText'] != [['BodyText','Section0']]:raise ValueError('Expected one section')
        body=doc.openstream('BodyText/Section0').read()
    if flags&1:body=zlib.decompress(body,-15)
    pos=0;cells=[];cell=None;table_count=0
    while pos<len(body):
        h=struct.unpack_from('<I',body,pos)[0];pos+=4
        tag=h&1023;size=h>>20
        if size==4095:size=struct.unpack_from('<I',body,pos)[0];pos+=4
        payload=body[pos:pos+size];pos+=size
        if tag==77:table_count+=1
        if tag==72 and len(payload)>=32:
            col,row,cs,rs=struct.unpack_from('<HHHH',payload,8)
            if cs!=1 or rs!=1:raise ValueError('Merged cells require manual review')
            cell={'row':row,'col':col,'paragraphs':[]};cells.append(cell)
        if tag==67 and cell is not None:cell['paragraphs'].append(text(payload))
    if table_count!=1 or len(cells)!=66:raise ValueError('Unexpected table dimensions')
    grid={(c['row'],c['col']):c['paragraphs'] for c in cells}
    if [grid[0,i][0] for i in range(1,6)]!=list('월화수목금'):raise ValueError('Unexpected weekday headers')
    for period in range(1,11):
        label=' '.join(grid[period,0]);match=re.search(r'(\d+):(\d+)-(\d+):(\d+)',label)
        if not match:raise ValueError('Missing period times')
        h1,m1,h2,m2=map(int,match.groups());h1+=12 if period>=5 and h1<12 else 0;h2+=12 if period>=5 and h2<12 else 0
        if (h1,m1,h2,m2)!=(period+8,0,period+8,50):raise ValueError('Period labels changed')
    slots=[]
    for period in range(1,11):
        for day in range(1,6):
            paragraphs=grid[period,day]
            for paragraph in paragraphs:
                if not paragraph or paragraph.startswith('*'):continue
                if paragraph.startswith('창업과진로:'):continue # following lines list four separate sections
                if paragraph.startswith('('):
                    matches=re.findall(r'\((\d+)반\)\s*(\d+-\d+)\s*\(([^)]+)\)',paragraph)
                    if not matches:raise ValueError('Unknown section line: '+paragraph)
                    items=[('창업과진로',sec,room,prof) for sec,room,prof in matches]
                else:
                    m=re.fullmatch(r'(.+?)\s+(\d+-\d+)\s*\(([^)]+)\)',paragraph)
                    if not m:raise ValueError('Unparsed course: '+paragraph)
                    name,room,prof=m.groups();sec='-'
                    sm=re.search(r'\((\d+)반\)',name)
                    if sm:sec=sm.group(1);name=name[:sm.start()]+name[sm.end():]
                    items=[(name,sec,room,prof)]
                for name,sec,room,prof in items:
                    # Not an official course code. Stable local ID, explicitly marked in data and UI.
                    code='HWP-'+hashlib.sha256((name+'|'+prof).encode()).hexdigest()[:12]
                    slots.append(dict(course_name=name,section=sec,room=room,instructor=prof,course_code=code,weekday=day,period=period))
    groups={}
    for s in slots:
        key=tuple(s[k] for k in ('course_code','section','weekday','room'))
        groups.setdefault(key,[]).append(s)
    meetings=[]
    for group in groups.values():
        group.sort(key=lambda x:x['period']);runs=[]
        for s in group:
            if not runs or s['period']!=runs[-1][-1]['period']+1:runs.append([])
            runs[-1].append(s)
        for run in runs:
            s=run[0];meetings.append(dict(semester='2026-2',campus='세종',course_code=s['course_code'],section=s['section'],course_name=s['course_name'],instructor=s['instructor'],weekday=s['weekday'],starts_at=f"{run[0]['period']+8:02}:00",ends_at=f"{run[-1]['period']+8:02}:50",valid_from='2026-09-01',valid_until='2026-12-18',source_url=SOURCE,room=s['room'],source_periods=[x['period'] for x in run]))
    meetings.sort(key=lambda r:(r['weekday'],r['starts_at'],r['course_code'],r['section']))
    return dict(scope='고려대학교 세종캠퍼스 정부행정학부 · 2026-2 · 2026-07-30 기준',source_file=Path(path).name,source_sha256=hashlib.sha256(raw).hexdigest(),source_url=SOURCE,calendar_url=CALENDAR,excluded_dates=HOLIDAYS,notes=['전체 대학 개설과목이 아닌 해당 학부 자료','HWP- 접두사는 로컬 ID이며 공식 학수번호 아님','section=-는 분반 미표기이며 01분반을 뜻하지 않음','연속 교시는 10분 휴식 시간을 포함한 한 수업 구간으로 병합','창업과진로는 통합운영 안내와 분반별 강의실을 함께 보존','휴강·보강 및 7월 30일 이후 정정은 별도 확인 필요'],meetings=meetings)

if __name__=='__main__':
    import argparse,importlib.util
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('hwp');ap.add_argument('--output',default='data/spa-2026-2');a=ap.parse_args()
    result=extract(a.hwp);prefix=Path(a.output);prefix.parent.mkdir(parents=True,exist_ok=True)
    prefix.with_suffix('.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    stream=io.StringIO();w=csv.DictWriter(stream,fieldnames=FIELDS,extrasaction='ignore');w.writeheader();w.writerows(result['meetings'])
    prefix.with_suffix('.csv').write_text(stream.getvalue(),encoding='utf-8')
    spec=importlib.util.spec_from_file_location('importer',Path(__file__).with_name('import-timetable.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    sql=m.convert(stream.getvalue());q=m.quote
    # Update only this imported source's excluded dates; unrelated catalogs are untouched.
    update="update public.course_meetings set excluded_dates=ARRAY["+','.join(q(d) for d in HOLIDAYS)+"]::date[] where source_url="+q(SOURCE)+" and semester='2026-2';\n"
    sql=sql.removesuffix('commit;\n')+update+'commit;\n'
    prefix.with_suffix('.sql').write_text('-- Source: '+SOURCE+'\n-- Local course IDs; see companion JSON for provenance and rooms.\n'+sql)
    print(len(result['meetings']),'meetings;',len({(x['course_code'],x['section']) for x in result['meetings']}),'course/sections')

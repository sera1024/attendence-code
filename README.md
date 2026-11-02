# 출석코드 공유소 (모의 프로젝트)

현재 수업 후보에서 과목·분반을 선택하고 LMS 출석 코드(숫자 4자리, 10분 유효)를 **올린 만큼만 남의 코드를 볼 수 있는** 실시간 공유 웹사이트입니다.
수업용 모의 프로젝트이며 실제 출석에는 사용하지 않습니다.

- 프론트엔드: 순수 HTML/CSS/JS (빌드 없음) → GitHub Pages로 배포
- 백엔드: Supabase (Auth · Postgres · Row Level Security · Realtime)

## 규칙

| 동작 | 결과 |
| --- | --- |
| 코드 1개 올리기 | 열람권 +1 |
| 남의 코드 1개 열기 | 열람권 -1 (이미 연 코드는 다시 봐도 무료) |
| 만료된 코드 열기 | 거절, 열람권 차감 없음 |
| 같은 과목에 연달아 올리기 | 내 코드가 유효한 동안은 거절 (열람권 부풀리기 방지) |
| 연 코드 평가 | "맞았어요 / 틀렸어요" — 틀렸다는 제보가 많으면 경고 표시 |

열람권 = (내가 올린 코드 수) − (내가 연 코드 수). 이 계산과 모든 쓰기는 **서버(Postgres 함수)에서만** 일어나므로 브라우저에서 값을 조작해도 소용없습니다.

## 구조

```
index.html          화면
style.css           스타일 (라이트/다크 모드, 모바일 대응)
app.js              로그인 · 올리기 · 열기 · 평가 · 실시간 구독
config.js           Supabase URL + anon 키
supabase/schema.sql 테이블 · RLS · RPC · Realtime 설정 (한 번 실행)
```

### 데이터가 새지 않는 이유

- `codes` 테이블: 과목, 올린 사람, 만료 시각, 열람 수 — **숫자 없음**. 로그인한 모두가 읽을 수 있고 Realtime으로 JSON 이벤트가 전송됩니다.
- `code_secrets` 테이블: 실제 4자리 숫자. RLS로 **올린 사람 본인 + 열람권을 써서 연 사람**만 읽을 수 있습니다.
- `unlocks`, `votes`: 본인 기록만 읽을 수 있습니다.
- insert/update/delete 정책이 없어서 클라이언트는 테이블에 직접 쓸 수 없고, `submit_code` / `unlock_code` / `vote_code` RPC로만 바꿀 수 있습니다.
- 같은 사용자의 동시 요청은 프로필 행 잠금으로 직렬화되어 열람권을 두 번 쓸 수 없습니다.

## 설정 방법

### 1. Supabase 스키마 적용

Supabase 대시보드 → **SQL Editor** → `supabase/schema.sql` 내용을 붙여넣고 **Run**.
(여러 번 실행해도 안전합니다.)

### 2. 이메일 로그인 설정

대시보드 → **Authentication**

1. **Sign In / Providers → Email**: 켜져 있는지 확인
2. **URL Configuration**
   - Site URL: `https://dlcofud.github.io/attendence-code/`
   - Redirect URLs에 추가: `https://dlcofud.github.io/attendence-code/**`, 로컬 테스트용 `http://localhost:8000/**`
3. Supabase 기본 메일 발송은 **시간당 몇 통**으로 제한돼 있어요. 여러 계정으로 테스트할 땐 Email 설정의 **Confirm email**을 잠시 꺼 두면 편합니다.

### 3. `config.js`에 키 넣기

대시보드 → **Project Settings → API Keys** 에서 `anon` `public` 키(또는 publishable 키)를 복사해 `SUPABASE_ANON_KEY`에 넣습니다.
이 키는 공개돼도 되는 키입니다. **`service_role` / secret 키는 절대 넣지 마세요.**

### 4. 로컬에서 실행

```bash
python -m http.server 8000
# 브라우저에서 http://localhost:8000
```

### 5. GitHub Pages 배포

```bash
git add .
git commit -m "출석코드 공유소 초기 버전"
git branch -M main
git push -u origin main
```

GitHub 저장소 → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main` / `(root)` → Save.
1~2분 뒤 `https://dlcofud.github.io/attendence-code/` 에서 열립니다.

## 실시간(JSON) 동작

`app.js`는 `codes` 테이블의 `postgres_changes`를 구독합니다.

- 누가 코드를 올리면 `INSERT` 이벤트 → 모든 접속자 화면에 카드가 즉시 추가
- 누가 코드를 열거나 평가하면 `UPDATE` 이벤트 → 열람 수·평가 수가 즉시 갱신
- 화면 아래 **실시간 JSON 로그**에서 받은 이벤트 원문을 확인할 수 있습니다

```json
{
  "eventType": "INSERT",
  "table": "codes",
  "new": {
    "id": 12,
    "course": "자료구조 01분반",
    "uploader_nickname": "민수",
    "created_at": "2026-11-02T01:03:00+00:00",
    "expires_at": "2026-11-02T01:11:00+00:00",
    "unlock_count": 0, "ok_count": 0, "bad_count": 0
  }
}
```

## 확장 아이디어

- 틀렸다는 제보가 일정 수를 넘은 코드는 올린 사람의 열람권 회수
- 과목 목록을 고정(드롭다운)해 오타로 과목이 갈라지는 것 방지
- 학교 이메일 도메인만 가입 허용


## 현재 수업 후보 선택 기능

자유 입력 대신 등록된 고려대학교 시간표에서 한국 시간(Asia/Seoul) 기준 **수업 시작 10분 전 이상, 종료 시각 미만**인 과목을 선택합니다. 1분마다 갱신되며 서울/세종 캠퍼스로 필터링할 수 있습니다. 과목명·학수번호·분반·수업 시각·담당교수를 표시합니다. 같은 이름이어도 학기·캠퍼스·학수번호·분반을 포함한 식별자로 기록하므로 다른 수업과 섞이지 않습니다.

**시간표상 후보이며 실제 LMS 출석 진행 여부를 의미하지 않습니다.** 교수자의 출석 공지 시각·휴강·공휴일·보강은 시간표만으로 자동 확정할 수 없습니다. 실제 출석에는 사용하지 않는 기존 모의 프로젝트 범위를 유지합니다.

### 적용 순서 (필수)

1. 처음 설정한다면 기존 `supabase/schema.sql`을 먼저 실행합니다.
2. 기존 프로젝트와 신규 프로젝트 모두 `supabase/timetable.sql`을 SQL Editor에서 실행합니다.
3. 검증한 실제 개설과목 시간표를 아래 형식의 UTF-8 CSV로 정리해 SQL로 변환하고 실행합니다.
4. 이 변경의 프론트엔드 파일을 배포합니다. **DB 변경·시간표 등록 전에는 과목 선택이 비어 있고 제출이 비활성화됩니다.**

기존 `schema.sql`을 다시 적용했다면 `timetable.sql`도 다시 적용해야 합니다. 기존 SQL이 자유 입력 RPC 실행 권한을 다시 부여하기 때문입니다. 새 화면은 `submit_scheduled_code` RPC를 사용하며 서버가 현재 수업 시간 여부를 다시 검증합니다.

### 시간표 가져오기

공식 조회: https://sugang.korea.ac.kr/p/v/lectList?lang=ko

학교의 공식 조회 화면에서 학기·캠퍼스·분반·수업 시간을 확인한 자료를 사용하세요. 현재 학기의 전체 과목 데이터는 포함되어 있지 않습니다. 첨부 HWP에서 추출한 세종캠퍼스 정부행정학부 자료는 `data/spa-2026-2.*`에 있습니다. 자동 실시간 동기화가 구현된 것은 아닙니다. 개발 과정에서 공식 조회 요청이 빈 목록을 반환해 실제 시간표를 검증·수집하지 못했으며, 임의 과목을 운영 데이터로 넣지 않았습니다.

CSV 헤더 (한 행은 한 요일의 한 수업 구간):

```csv
semester,campus,course_code,section,course_name,instructor,weekday,starts_at,ends_at,valid_from,valid_until,source_url
```

- `semester`: 예: `2026-2`, `campus`: `서울` 또는 `세종`.
- `section`: 문자열이므로 `01` 같은 앞자리 0을 유지합니다.
- `weekday`: 월~일 또는 1~7 (월요일=1).
- `starts_at`, `ends_at`: 공식 시간표를 확인한 `HH:MM` 형식. 교시를 임의의 시각으로 추측하지 않습니다.
- `valid_from`, `valid_until`: 실제 학기/수업 운영 기간 `YYYY-MM-DD`. 여름/겨울 계절학기도 별도 기간으로 등록합니다.
- `source_url`: 검증한 `https://*.korea.ac.kr/…` 출처.
- 주 2회면 요일별로 두 행을 넣습니다. 비동기 온라인 강의·시간 미정 강의는 후보에서 제외합니다.

```sh
python3 scripts/import-timetable.py timetable.csv timetable-import.sql
```

생성된 SQL을 확인한 뒤 Supabase SQL Editor에서 실행합니다. CSV 전체 검증 후에만 파일을 생성하며 잘못된 시각·중복·빈 데이터는 오류로 처리합니다. 같은 시간표를 다시 가져오면 갱신됩니다. 기존에 등록된 과목 삭제나 제외 날짜 변경은 자동으로 하지 않습니다.

운영자는 `course_meetings`에서 휴강/공휴일을 `excluded_dates`에 날짜 배열로 등록하고, 폐강·삭제된 시간표는 `enabled=false`로 변경하세요. 정정 후 시작 시간이 바뀐 경우 기존 행도 비활성화하세요. 학생에게 시간표 수정 권한은 주지 않습니다.

### 검증

```sh
npm ci
npm test
```

빌드 도구 없이 기존 정적 HTML/CSS/JS로 실행합니다. npm은 개발 검증용입니다. 테스트는 PGlite PostgreSQL 엔진에서 스키마·반복 migration 적용, 시작 10분 전/종료 경계, 중복 제출, 포인트, 위조된 수업 ID, 권한, 제외 날짜, 비로그인을 확인합니다. Supabase Auth와 Realtime의 실제 연결 테스트는 포함하지 않습니다.


### 첨부 HWP 시간표 적용 (2026-2 정부행정학부)

**이 자료의 범위는 세종캠퍼스 정부행정학부이며 고려대학교 전체 시간표가 아닙니다.** 2026-07-30 기준 공지의 시간표에서 추출한 22개 과목/분반, 37개 주간 수업 구간을 포함합니다. 과목/분반 수에는 문서에 표기되지 않은 분반을 별도 번호로 추정하지 않고 하나의 항목으로 집계합니다.

- `data/spa-2026-2.csv`: DB 가져오기용 정규화 데이터.
- `data/spa-2026-2.json`: 출처·원본 SHA-256·강의실·원본 교시·처리 기준 포함.
- `data/spa-2026-2.sql`: 즉시 적용 가능한 데이터 SQL (여러 번 실행 가능).
- `scripts/extract-spa-hwp.py`: 이 문서의 표 구조를 검증하는 추출기. 다른 문서 구조는 오류로 중단합니다.

기존 Supabase 프로젝트에서는 SQL Editor에서 **`supabase/timetable.sql` → `data/spa-2026-2.sql` 순서**로 실행하세요. 처음 설정할 때만 그 전에 기존 `supabase/schema.sql`도 실행합니다. SQL을 실행하는 것은 DB에 실제 데이터를 등록하는 작업이며 GitHub merge만으로 실행되지 않습니다.

문서에는 학수번호가 없어 `HWP-` 내부 식별자를 사용합니다. 공식 학수번호로 표시하지 않습니다. 분반 미표기는 `-`로 보존하고 화면에 '분반 미표기'라고 표시합니다. 행정학의이해 01/02 및 창업과진로 61~64분반은 원문대로 구분합니다. 창업과진로의 통합운영강의실은 2-226호이고 분반별 장소는 JSON에 보존합니다.

문서의 5~10교시는 오후 13:00~18:50임을 공식 교시 안내와 확인했습니다. 연속 교시의 같은 수업은 중간 10분 휴식도 포함한 한 구간으로 합쳤습니다. 학기 운영 범위는 공식 학사일정의 2026-09-01~2026-12-18이며 추석·개천절·대체휴일·한글날을 제외했습니다. 중간/기말고사, 교수자 개별 휴강·보강은 자동으로 제외하지 않습니다. 7월 30일 이후 정정 사항은 별도로 확인해야 합니다.

재생성:

```sh
python3 -m pip install olefile==0.47
python3 scripts/extract-spa-hwp.py "2026학년도 2학기 강의시간표.hwp"
```

수업 시간표 출처: https://spa.korea.ac.kr/spa/4479/subview.do?enc=Zm5jdDF8QEB8JTJGYmJzJTJGc3BhJTJGMTQ5JTJGMjcxNDM4JTJGYXJ0Y2xWaWV3LmRvJTNG

학사일정 출처: https://digb.korea.ac.kr/dhe/14117/subview.do

교시 안내: https://nursing.korea.ac.kr/nursing/community/notice_under.do?articleNo=812114&mode=view

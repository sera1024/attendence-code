/* 출석코드 공유소 — 프론트엔드 (모의 프로젝트)
 * - Supabase Auth(이메일+비밀번호) 로그인
 * - RPC: submit_code / unlock_code / vote_code / my_stats  (규칙은 서버에서 강제)
 * - Realtime: codes 테이블 변경(JSON)을 구독해 목록을 즉시 갱신
 */
(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);
  const WINDOW_MIN = 60;          // 최근 60분 안에 만료된 코드까지 불러옴
  const LOG_MAX = 30;

  const views = { setup: $('#view-setup'), auth: $('#view-auth'), app: $('#view-app') };
  function show(name) {
    for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    $('#session').hidden = name !== 'app';
  }

  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !/YOUR_/.test(cfg.SUPABASE_ANON_KEY);
  if (!configured || !window.supabase) {
    show('setup');
    if (configured && !window.supabase) {
      $('#view-setup p').textContent = 'Supabase 라이브러리를 불러오지 못했어요. 네트워크를 확인하고 새로고침해 주세요.';
    }
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const state = {
    user: null,
    nickname: '',
    codes: new Map(),     // id -> codes 행
    secrets: new Map(),   // id -> '1234' (내 코드 + 내가 연 코드)
    votes: new Map(),     // id -> true/false (내 평가)
    stats: { uploaded: 0, unlocked: 0, credits: 0 },
    fresh: new Set(),     // 방금 들어온 남의 코드 (강조 표시)
    channel: null,
    subscribedOnce: false,
    filter: '',
    showExpired: false,
    log: [],
  };
  const cardEls = new Map();

  /* ------------------------------------------------------------------ *
   *  유틸
   * ------------------------------------------------------------------ */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  // Postgres/Realtime 타임스탬프를 어떤 형식으로 받아도 ms 로 변환
  function parseTs(s) {
    if (!s) return NaN;
    let t = String(s).trim().replace(' ', 'T');
    t = t.replace(/(\.\d{3})\d+/, '$1');
    t = t.replace(/([+-]\d{2})$/, '$1:00');
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) t += 'Z';
    return Date.parse(t);
  }

  function fmtLeft(ms) {
    if (ms <= 0) return '만료';
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtAgo(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    return `${Math.floor(m / 60)}시간 전`;
  }

  function toast(msg, kind) {
    const el = h('div', { class: `toast ${kind || ''}`, text: msg });
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 4500 : 2600);
  }

  /* ------------------------------------------------------------------ *
   *  로그인 / 회원가입
   * ------------------------------------------------------------------ */
  let authMode = 'login';
  const authForm = $('#form-auth');
  const authMsg = $('#auth-msg');

  function setAuthMsg(text, kind) {
    authMsg.textContent = text || '';
    authMsg.className = `form-msg ${kind || ''}`;
  }

  function setAuthMode(mode, keepMsg) {
    authMode = mode;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === mode)));
    $('#field-nick').hidden = mode !== 'signup';
    $('#auth-submit').textContent = mode === 'signup' ? '가입하기' : '로그인';
    authForm.password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
    if (!keepMsg) setAuthMsg('');
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.tab)));

  function authError(err) {
    const m = String((err && err.message) || '').toLowerCase();
    if (m.includes('invalid login')) return '이메일 또는 비밀번호가 맞지 않아요.';
    if (m.includes('email not confirmed')) return '이메일 인증을 먼저 완료해 주세요. 받은편지함(스팸함 포함)을 확인해 보세요.';
    if (m.includes('already registered')) return '이미 가입된 이메일이에요. 로그인해 주세요.';
    if (m.includes('rate limit')) return '인증 메일 발송 한도를 넘었어요. 잠시 후 다시 시도해 주세요.';
    if (m.includes('password')) return '비밀번호는 6자 이상이어야 해요.';
    if (m.includes('email')) return '이메일 형식을 확인해 주세요.';
    return (err && err.message) || '알 수 없는 오류가 발생했어요.';
  }

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = authForm.email.value.trim();
    const password = authForm.password.value;
    const nickname = authForm.nickname.value.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setAuthMsg('이메일 형식을 확인해 주세요.', 'error');
    if (password.length < 6) return setAuthMsg('비밀번호는 6자 이상이어야 해요.', 'error');
    if (authMode === 'signup' && (nickname.length < 1 || nickname.length > 20)) {
      return setAuthMsg('닉네임을 1~20자로 입력해 주세요.', 'error');
    }

    const btn = $('#auth-submit');
    btn.disabled = true;
    setAuthMsg(authMode === 'signup' ? '가입 중…' : '로그인 중…');
    try {
      if (authMode === 'signup') {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { data: { nickname }, emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) {
          // 이메일 인증이 켜져 있으면 세션 없이 돌아옴. identities 가 비어 있으면 이미 가입된 이메일.
          if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
            setAuthMode('login', true);
            setAuthMsg('이미 가입된 이메일이에요. 로그인해 주세요.', 'error');
          } else {
            setAuthMode('login', true);
            setAuthMsg('인증 메일을 보냈어요. 메일의 링크를 누르면 자동으로 로그인돼요.', 'ok');
          }
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setAuthMsg(authError(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#logout').addEventListener('click', () => sb.auth.signOut());

  // 콜백 안에서 바로 supabase 호출을 하면 교착될 수 있어 다음 틱으로 미룸
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => handleSession(session), 0));

  async function handleSession(session) {
    const user = session && session.user;
    if (!user) {
      teardown();
      show('auth');
      return;
    }
    if (state.user && state.user.id === user.id) return; // 토큰 갱신 등
    state.user = user;
    show('app');
    try {
      await Promise.all([loadProfile(), loadStats(), loadCodes(), loadCourses()]);
    } catch (err) {
      toast(`불러오기 실패: ${err.message || err}`, 'error');
    }
    subscribe();
  }

  function teardown() {
    courseRequest++;
    courseRows = [];
    coursesLoaded = false;
    renderCourses();
    if (state.channel) sb.removeChannel(state.channel);
    Object.assign(state, {
      user: null, nickname: '', channel: null, subscribedOnce: false,
      codes: new Map(), secrets: new Map(), votes: new Map(), fresh: new Set(), log: [],
      stats: { uploaded: 0, unlocked: 0, credits: 0 },
    });
    cardEls.clear();
    $('#cards').replaceChildren();
    renderLog();
    setLive('CLOSED');
  }

  /* ------------------------------------------------------------------ *
   *  데이터 불러오기
   * ------------------------------------------------------------------ */
  async function loadProfile() {
    const { data } = await sb.from('profiles').select('nickname').eq('id', state.user.id).maybeSingle();
    state.nickname = (data && data.nickname)
      || (state.user.user_metadata && state.user.user_metadata.nickname)
      || state.user.email;
    $('#me-nick').textContent = state.nickname;
  }

  async function loadStats() {
    const { data, error } = await sb.rpc('my_stats');
    if (error) throw error;
    setStats(data);
  }

  function setStats(s) {
    if (!s) return;
    state.stats = { uploaded: Number(s.uploaded) || 0, unlocked: Number(s.unlocked) || 0, credits: Number(s.credits) || 0 };
    $('#stat-uploaded').textContent = state.stats.uploaded;
    $('#stat-unlocked').textContent = state.stats.unlocked;
    $('#stat-credits').textContent = state.stats.credits;
    $('#credit-pill').textContent = state.stats.credits;
    renderAll();
  }

  async function loadCodes() {
    const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
    const { data, error } = await sb
      .from('codes')
      .select('*')
      .gte('expires_at', since)
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    state.codes = new Map(data.map((r) => [r.id, r]));
    const ids = data.map((r) => r.id);
    if (ids.length) {
      const [sec, vot] = await Promise.all([
        sb.from('code_secrets').select('code_id, code').in('code_id', ids), // RLS: 내 것 + 연 것만 옴
        sb.from('votes').select('code_id, ok').in('code_id', ids),
      ]);
      if (sec.error) throw sec.error;
      if (vot.error) throw vot.error;
      sec.data.forEach((s) => state.secrets.set(s.code_id, s.code));
      vot.data.forEach((v) => state.votes.set(v.code_id, v.ok));
    }
    renderAll();
  }

  /* ------------------------------------------------------------------ *
   *  실시간
   * ------------------------------------------------------------------ */
  function setLive(status) {
    const el = $('#live');
    const text = $('#live-text');
    if (status === 'SUBSCRIBED') { el.dataset.state = 'on'; text.textContent = '실시간'; }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { el.dataset.state = 'error'; text.textContent = '재연결 중'; }
    else { el.dataset.state = 'off'; text.textContent = '연결 중'; }
  }

  function subscribe() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = sb
      .channel('codes-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'codes' }, onChange)
      .subscribe((status) => {
        setLive(status);
        if (status === 'SUBSCRIBED') {
          if (state.subscribedOnce) loadCodes().catch(() => {}); // 재연결 시 놓친 변경 동기화
          state.subscribedOnce = true;
        }
      });
  }

  function onChange(p) {
    pushLog(p);
    if (!state.user) return;
    if (p.eventType === 'INSERT') {
      const r = p.new;
      state.codes.set(r.id, r);
      if (r.uploader_id !== state.user.id) {
        state.fresh.add(r.id);
        setTimeout(() => { state.fresh.delete(r.id); refreshCard(r.id); }, 5000);
        toast(`새 코드: ${r.course} (${r.uploader_nickname})`);
      }
      renderAll();
    } else if (p.eventType === 'UPDATE') {
      const prev = state.codes.get(p.new.id) || {};
      state.codes.set(p.new.id, { ...prev, ...p.new });
      refreshCard(p.new.id);
    } else if (p.eventType === 'DELETE') {
      const id = p.old && p.old.id;
      state.codes.delete(id);
      renderAll();
    }
  }

  function pushLog(p) {
    state.log.unshift({
      received_at: new Date().toISOString(),
      eventType: p.eventType,
      table: p.table,
      commit_timestamp: p.commit_timestamp,
      new: p.new && Object.keys(p.new).length ? p.new : undefined,
      old: p.old && Object.keys(p.old).length ? p.old : undefined,
    });
    state.log.length = Math.min(state.log.length, LOG_MAX);
    renderLog();
  }

  function renderLog() {
    $('#log').textContent = state.log.length
      ? state.log.map((e) => JSON.stringify(e, null, 2)).join('\n\n')
      : '아직 받은 이벤트가 없어요. 누군가 코드를 올리면 여기에 JSON으로 찍혀요.';
    $('#log-count').textContent = `${state.log.length}건`;
  }

  /* ------------------------------------------------------------------ *
   *  화면 그리기
   * ------------------------------------------------------------------ */
  function visibleCodes() {
    const now = Date.now();
    const q = state.filter.trim().toLowerCase();
    const rows = [...state.codes.values()].filter((r) => {
      const expired = parseTs(r.expires_at) <= now;
      if (expired && !state.showExpired) return false;
      if (q && !r.course.toLowerCase().includes(q)) return false;
      return true;
    });
    return rows.sort((a, b) => {
      const ea = parseTs(a.expires_at) <= now;
      const eb = parseTs(b.expires_at) <= now;
      if (ea !== eb) return ea ? 1 : -1;
      return parseTs(b.created_at) - parseTs(a.created_at);
    });
  }

  function renderAll() {
    if (!state.user) return;
    const list = visibleCodes();
    const keep = new Set(list.map((r) => r.id));
    for (const [id, el] of cardEls) {
      if (!keep.has(id)) { el.remove(); cardEls.delete(id); }
    }
    const box = $('#cards');
    list.forEach((r, i) => {
      let el = cardEls.get(r.id);
      if (!el) {
        el = h('article', { class: 'code-card' });
        cardEls.set(r.id, el);
      }
      fillCard(el, r.id);
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });
    $('#empty').hidden = list.length > 0;
    $('#empty').textContent = state.filter
      ? '검색한 과목의 코드가 없어요.'
      : '아직 유효한 코드가 없어요. 첫 코드를 올려 보세요.';

  }

  function refreshCard(id) {
    const el = cardEls.get(id);
    if (el) fillCard(el, id);
  }

  function fillCard(el, id) {
    const r = state.codes.get(id);
    if (!r) return;
    const now = Date.now();
    const created = parseTs(r.created_at);
    const expires = parseTs(r.expires_at);
    const expired = expires <= now;
    const mine = r.uploader_id === state.user.id;
    const secret = state.secrets.get(id);
    const myVote = state.votes.has(id) ? state.votes.get(id) : null;
    const suspicious = r.bad_count >= 2 && r.bad_count > r.ok_count;

    el.className = ['code-card', mine && 'mine', expired && 'expired', state.fresh.has(id) && 'fresh']
      .filter(Boolean).join(' ');
    el.dataset.expired = String(expired);
    el._created = created;
    el._expires = expires;

    const time = h('span', { class: 'cc-time' });
    const bar = h('div', { class: 'bar' }, h('i'));
    const ago = h('span');
    el._time = time; el._bar = bar; el._ago = ago;

    // 코드 영역
    let digits;
    let action = null;
    if (secret) {
      digits = h('span', { class: 'digits', text: secret });
      action = h('button', {
        class: 'btn soft sm', text: '복사',
        onclick: () => navigator.clipboard.writeText(secret).then(() => toast('코드를 복사했어요'), () => toast('복사하지 못했어요', 'error')),
      });
    } else {
      digits = h('span', { class: 'digits hidden', text: '••••', 'aria-label': '가려진 코드' });
      if (!expired) {
        const noCredit = state.stats.credits <= 0;
        action = h('button', {
          class: 'btn primary sm',
          text: noCredit ? '열람권 없음' : '열람권 1개로 보기',
          disabled: noCredit,
          title: noCredit ? '코드를 하나 올리면 열람권이 생겨요' : undefined,
          onclick: (ev) => unlock(id, ev.currentTarget),
        });
      }
    }

    // 하단: 열람 수 + 평가
    let votes;
    if (secret && !mine) {
      votes = h('div', { class: 'votes' },
        h('button', { class: 'vote ok', 'aria-pressed': String(myVote === true), text: `맞았어요 ${r.ok_count}`, onclick: () => vote(id, true) }),
        h('button', { class: 'vote bad', 'aria-pressed': String(myVote === false), text: `틀렸어요 ${r.bad_count}`, onclick: () => vote(id, false) }),
      );
    } else {
      votes = h('span', { text: `맞음 ${r.ok_count} · 틀림 ${r.bad_count}` });
    }

    el.replaceChildren(
      h('div', { class: 'cc-top' },
        h('div', null,
          h('div', { class: 'cc-course', text: r.course }),
          h('div', { class: 'cc-meta' }, `${r.uploader_nickname} · `, ago),
        ),
        h('div', { style: 'display:grid;justify-items:end;gap:4px' },
          time,
          mine ? h('span', { class: 'tag', text: '내 코드' }) : null,
          suspicious ? h('span', { class: 'tag warn', text: '틀렸다는 제보 많음' }) : null,
        ),
      ),
      bar,
      h('div', { class: 'cc-code' }, digits, action),
      h('div', { class: 'cc-foot' }, h('span', { text: `열람 ${r.unlock_count}명` }), votes),
    );
    tickCard(el, now);
  }

  function tickCard(el, now) {
    const left = el._expires - now;
    const total = Math.max(el._expires - el._created, 1);
    const soon = left > 0 && left < 60000;
    el._time.textContent = fmtLeft(left);
    el._time.className = `cc-time${soon ? ' soon' : ''}${left <= 0 ? ' over' : ''}`;
    el._bar.className = `bar${soon ? ' soon' : ''}`;
    el._bar.firstChild.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
    el._ago.textContent = fmtAgo(el._created);
  }

  // 1초마다 남은 시간 갱신, 만료 순간에는 카드 상태/정렬 갱신
  setInterval(() => {
    if (!state.user) return;
    const now = Date.now();
    let changed = false;
    for (const el of cardEls.values()) {
      if (String(el._expires <= now) !== el.dataset.expired) changed = true;
      else tickCard(el, now);
    }
    if (changed) renderAll();
  }, 1000);

  let courseRows = [];
  let courseRequest = 0;
  let submitting = false;
  let coursesLoaded = false;

  function renderCourses() {
    const select = $('#course-select');
    const previous = select.value;
    const campus = $('#campus-filter').value;
    const rows = courseRows.filter(r => !campus || r.campus === campus);
    select.replaceChildren(h('option', { value: '', text: rows.length ? '수업을 선택하세요' : '현재 시간대의 수업이 없어요' }));
    rows.forEach(r => {
      const section = r.section === '-' ? '분반 미표기' : `${r.section}분반`;
      const identity = r.course_code.startsWith('HWP-') ? section : `${r.course_code} · ${section}`;
      select.append(h('option', {
        value: String(r.id),
        text: `${r.course_name} · ${identity} · ${r.campus} · ${r.starts_at.slice(0,5)}–${r.ends_at.slice(0,5)}${r.instructor ? ' · ' + r.instructor : ''}`,
      }));
    });
    if (rows.some(r => String(r.id) === previous)) select.value = previous;
    select.disabled = !coursesLoaded || !rows.length || submitting;
    $('#upload-submit').disabled = !coursesLoaded || !select.value || submitting;
  }

  async function loadCourses() {
    if (!state.user) return;
    const request = ++courseRequest;
    const userId = state.user.id;
    coursesLoaded = false;
    renderCourses();
    $('#course-status').textContent = '시간표 확인 중…';
    try {
      const { data, error } = await sb.rpc('current_course_meetings');
      if (error) throw error;
      if (request !== courseRequest || state.user?.id !== userId) return;
      courseRows = data || [];
      coursesLoaded = true;
      $('#course-status').textContent = courseRows.length
        ? `현재 수업 후보 ${courseRows.length}개 · 서버 시각 기준 (1분마다 갱신)`
        : '등록된 시간표에 현재 수업이 없어요. 시간표 미등록·방학·휴강일일 수 있어요.';
    } catch (err) {
      if (request !== courseRequest || state.user?.id !== userId) return;
      courseRows = [];
      $('#course-status').textContent = '시간표를 불러오지 못했어요. 새로고침해 주세요. 계속 실패하면 운영자가 시간표 DB 설정을 확인해야 해요.';
    }
    renderCourses();
  }
  $('#campus-filter').addEventListener('change', renderCourses);
  $('#course-select').addEventListener('change', () => {
    $('#upload-submit').disabled = !coursesLoaded || !$('#course-select').value || submitting;
  });
  $('#refresh-courses').addEventListener('click', loadCourses);
  setInterval(loadCourses, 60000);

  /* ------------------------------------------------------------------ *
   *  동작: 올리기 / 열기 / 평가
   * ------------------------------------------------------------------ */
  const uploadForm = $('#form-upload');
  uploadForm.code.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const meetingId = uploadForm.course.value;
    const code = uploadForm.code.value.trim();
    const minutes = Number(uploadForm.minutes.value);
    if (submitting) return;
    if (!coursesLoaded || !meetingId) return toast('현재 수업 후보에서 과목을 선택해 주세요.', 'error');
    if (!/^\d{4}$/.test(code)) return toast('출석 코드는 숫자 4자리예요.', 'error');

    const btn = $('#upload-submit');
    submitting = true;
    renderCourses();
    btn.disabled = true;
    try {
      const { data, error } = await sb.rpc('submit_scheduled_code', { p_meeting_id: meetingId, p_code: code, p_minutes: minutes });
      if (error) throw error;
      state.secrets.set(data.id, data.code);
      uploadForm.code.value = '';
      uploadForm.minutes.value = '10';
      if (!state.codes.has(data.id)) {
        // 실시간 이벤트보다 응답이 먼저 오면 직접 한 번 읽어 옴
        const { data: row } = await sb.from('codes').select('*').eq('id', data.id).maybeSingle();
        if (row) state.codes.set(row.id, row);
      }
      setStats(data.stats);
      toast('코드를 올렸어요. 열람권 +1');
    } catch (err) {
      toast(err.message || '올리지 못했어요.', 'error');
    } finally {
      submitting = false;
      await loadCourses();
    }
  });

  async function unlock(id, btn) {
    if (btn) btn.disabled = true;
    const { data, error } = await sb.rpc('unlock_code', { p_code_id: id });
    if (error) {
      toast(error.message || '열지 못했어요.', 'error');
      if (btn) btn.disabled = false;
      loadStats().catch(() => {});
      return;
    }
    state.secrets.set(id, data.code);
    setStats(data.stats);
    toast(data.charged ? '열람권 1개를 사용했어요.' : '이미 연 코드예요.');
  }

  async function vote(id, ok) {
    const { data, error } = await sb.rpc('vote_code', { p_code_id: id, p_ok: ok });
    if (error) return toast(error.message || '평가하지 못했어요.', 'error');
    state.votes.set(id, data.my_vote);
    const r = state.codes.get(id);
    if (r) { r.ok_count = data.ok_count; r.bad_count = data.bad_count; }
    refreshCard(id);
  }

  /* ------------------------------------------------------------------ *
   *  필터 / 기타
   * ------------------------------------------------------------------ */
  $('#filter').addEventListener('input', (e) => { state.filter = e.target.value; renderAll(); });
  $('#show-expired').addEventListener('change', (e) => { state.showExpired = e.target.checked; renderAll(); });

  // 탭이 잠들었다 깨면 놓친 변경을 다시 동기화
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) {
      loadCourses();
      loadCodes().catch(() => {});
      loadStats().catch(() => {});
    }
  });

  renderLog();
})();

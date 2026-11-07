(() => {
"use strict";

// ---------- 역할/추천 데이터 (표시용. 실제 판정은 서버) ----------
const ROLES = {
  merlin:   {name:"멀린",     team:"g", desc:"악의 세력이 누군지 알고 있습니다. 하지만 들키면 암살당해요. 은근히 선을 이끄세요."},
  percival: {name:"퍼시벌",   team:"g", desc:"멀린이 누군지 압니다(모르가나가 있으면 둘 중 누가 진짜인지는 모름). 멀린을 지키세요."},
  servant:  {name:"신하",     team:"g", desc:"아무 정보도 없습니다. 대화와 투표로 악을 찾아내세요."},
  assassin: {name:"암살자",   team:"e", desc:"동료 악을 압니다. 선이 원정 3번을 성공해도, 마지막에 멀린을 맞히면 악이 승리합니다."},
  morgana:  {name:"모르가나", team:"e", desc:"동료 악을 압니다. 퍼시벌에게 멀린처럼 보이니 멀린 행세로 퍼시벌을 헷갈리게 하세요."},
  mordred:  {name:"모드레드", team:"e", desc:"동료 악을 압니다. 멀린에게도 정체가 보이지 않는 악의 우두머리입니다."},
  oberon:   {name:"오베론",   team:"e", desc:"악이지만 다른 악을 모르고, 다른 악도 당신을 모릅니다. (멀린에게는 보임)"},
  minion:   {name:"수하",     team:"e", desc:"동료 악을 압니다. 원정을 실패시키고 정체를 숨기세요."}
};
// 퍼시벌 설명은 모르가나 유무에 따라 달라짐
function roleDesc(k){
  if(k==="percival"){
    return S && S.game && S.game.roleCounts.morgana
      ? "멀린과 모르가나가 누군지 압니다. 멀린을 찾아서 지키세요."
      : "멀린이 누군지 압니다. 멀린을 지키세요.";
  }
  return ROLES[k].desc;
}
const ROLE_ORDER = ["merlin","percival","servant","assassin","morgana","mordred","oberon","minion"];
const P = (percival,morgana,mordred,oberon) => ({percival,morgana,mordred,oberon});
const RECOMMEND = {
  5: [{label:"기본", opts:P(0,0,0,0)}],
  6: [{label:"모르가나", opts:P(1,1,0,0)},
      {label:"모드레드", opts:P(1,0,1,0)}],
  7: [{label:"입문 (특수역할 없음)", opts:P(0,0,0,0)},
      {label:"+오베론 (선 유리)", opts:P(1,1,0,1)},
      {label:"+수하", opts:P(1,1,0,0)},
      {label:"+모드레드 (악 유리)", opts:P(1,1,1,0)}],
  8: [{label:"입문 (특수역할 없음)", opts:P(0,0,0,0)},
      {label:"+오베론 (선 유리)", opts:P(1,1,0,1)},
      {label:"+수하", opts:P(1,1,0,0)},
      {label:"+모드레드 (악 유리)", opts:P(1,1,1,0)}],
  9: [{label:"기본", opts:P(1,1,1,0)}],
  10:[{label:"+오베론", opts:P(1,1,1,1)},
      {label:"+수하", opts:P(1,1,1,0)}]
};
const OPT_NAMES = {percival:"퍼시벌", morgana:"모르가나", mordred:"모드레드", oberon:"오베론"};
const EVIL_COUNT = {5:2,6:2,7:3,8:3,9:3,10:4};
const TEAM_SIZES = {5:[2,3,2,3,3],6:[2,3,4,3,4],7:[2,3,3,4,4],8:[3,4,4,5,5],9:[3,4,4,5,5],10:[3,4,4,5,5]};
function comboText(n, o){
  const evilN = EVIL_COUNT[n];
  const good = ["멀린"]; if(o.percival) good.push("퍼시벌");
  const gs = n - evilN - good.length; if(gs>0) good.push(`신하 ${gs}`);
  const evil = ["암살자"]; ["morgana","mordred","oberon"].forEach(k=>{ if(o[k]) evil.push(OPT_NAMES[k]); });
  const ms = evilN - evil.length; if(ms>0) evil.push(`수하 ${ms}`);
  return {good:good.join("+"), evil:evil.join("+")};
}
const sameOpts = (a,b) => Object.keys(OPT_NAMES).every(k=>!!a[k]===!!b[k]);

// ---------- 유틸 ----------
const $app = document.getElementById("app");
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const LS = {
  get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} }
};
const SESSION_KEY = "roundtable-spy-online";

// ---------- 상태 ----------
let S = null;                 // 서버가 보내준 내 화면 상태
let session = LS.get(SESSION_KEY); // {code, token}
const urlRoom = (new URLSearchParams(location.search).get("room") || location.pathname.replace(/\D/g,"")).slice(0,4);
const ui = {
  name: LS.get("roundtable-spy-name") || "",
  code: urlRoom || "",
  roleOpen: false, error: null, notice: null,
  connected: false, busy: false, animQuest: null, lastPhaseKey: null
};

// ---------- 연결 ----------
let ws = null, retry = 0, retryTimer = null;
function connect(){
  clearTimeout(retryTimer);
  if(ui.replaced) return;
  if(ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0; ui.connected = true;
    if(session) send({t:"resume", code:session.code, token:session.token});
    render();
  };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if(m.t === "joined"){ session = {code:m.code, token:m.token}; LS.set(SESSION_KEY, session); ui.busy=false; history.replaceState(null, "", `?room=${m.code}`); }
    else if(m.t === "state"){ onState(m.state); }
    else if(m.t === "error"){ ui.error = m.msg; ui.busy=false; render(); }
    else if(m.t === "gone"){ leaveLocal("방이 사라졌거나 자리가 없어요."); }
    else if(m.t === "kicked"){ leaveLocal(m.reason); }
    else if(m.t === "replaced"){ ui.replaced = true; S = null; render(); }
  };
  ws.onclose = () => {
    ui.connected = false; ws = null; render();
    if(ui.replaced) return;
    retryTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}
function send(obj){ if(ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function act(obj){ ui.error = null; send(obj); }
function leaveLocal(reason){
  session = null; S = null; LS.del(SESSION_KEY); ui.busy=false;
  ui.notice = reason || null; ui.roleOpen = false;
  history.replaceState(null, "", location.pathname.replace(/\d+$/,""));
  render();
}
document.addEventListener("visibilitychange", () => { if(!document.hidden) connect(); });
window.addEventListener("online", connect);

function onState(st){
  const prevPhase = S && S.phase;
  S = st;
  // 내 차례가 되면 진동
  const key = st.phase + ":" + (st.game ? `${st.game.questIdx}:${st.game.rejects}` : "");
  if(key !== ui.lastPhaseKey){
    ui.lastPhaseKey = key;
    if(prevPhase && myTurn()) try{ navigator.vibrate && navigator.vibrate(120); }catch(e){}
    if(st.phase !== "reveal") ui.roleOpen = false;
    if(st.phase === "lobby" || st.phase === "end" || (prevPhase !== "reveal" && st.phase === "reveal")) ui.menuOpen = false;
    ui.error = null;
    if(prevPhase !== st.phase) window.scrollTo(0,0);
  }
  render();
}

// ---------- 헬퍼 ----------
const G = () => S.game;
const isHost = () => S.hostId === S.me.id;
const meIdx = () => G().my.idx;
const pname = i => esc(S.players[i].name);
const isLeader = () => G().leader === meIdx();
function myTurn(){
  if(!S || !S.game) return false;
  const g = G(), me = meIdx();
  switch(S.phase){
    case "reveal": return !g.revealed[me];
    case "team": return g.leader === me;
    case "vote": return g.my.vote === null;
    case "quest": return g.team.includes(me) && g.my.questVote === null;
    case "assassin": return g.my.role === "assassin";
    default: return false;
  }
}

// ---------- 공용 조각 ----------
function board(){
  const g = G(), sizes = TEAM_SIZES[g.count];
  const q = sizes.map((sz,k)=>{
    const res = g.quests[k];
    const cls = res ? res.result : (k===g.questIdx && S.phase!=="end" ? "cur" : "");
    const two = (k===3 && g.count>=7) ? `<span class="two">실패2</span>` : "";
    return `<div class="q ${cls}"><span class="n">${k+1}원정</span>${res ? (res.result==="s"?"✓":"✗") : sz}${two}</div>`;
  }).join("");
  let dots = "";
  for(let k=0;k<5;k++) dots += `<div class="dot ${k<g.rejects?"x":""} ${k===4?"last":""}">${k+1}</div>`;
  return `<div class="card">
    <div class="quests">${q}</div>
    <div class="center muted" style="margin-top:12px">부결 트랙 (5번 부결 시 악 승리)</div>
    <div class="track">${dots}</div>
  </div>`;
}

function infoHtml(info){
  if(!info) return "";
  let s = "";
  if(info.label) s += `${esc(info.label)}: ${info.names.length ? info.names.map(n=>`<b>${esc(n)}</b>`).join(", ") : "(보이는 사람 없음)"}`;
  info.notes.forEach(n => { s += (s?"<br>":"") + (info.label ? `<span class="muted">※ ${esc(n)}</span>` : esc(n)); });
  return s;
}

function roleCard(){
  const g = G(), r = ROLES[g.my.role];
  return `<div class="role ${r.team}">
    <div class="pill ${r.team}">${r.team==="g"?"선의 세력":"악의 세력"}</div>
    <div class="name">${r.name}</div>
    <div class="desc">${roleDesc(g.my.role)}</div>
    <div class="info">${infoHtml(g.my.info)}</div>
  </div>`;
}

// 게임 중 언제든 내 역할 다시 보기 (기본은 가려둠)
function myRoleBox(){
  if(ui.roleOpen) return `<div class="card">${roleCard()}<div class="gap"></div><button data-act="roleHide">가리기</button></div>`;
  return `<button class="ghost" data-act="roleShow">🔒 내 역할 다시 보기</button><div class="gap"></div>`;
}

function roleGuide(){
  const cnt = G().roleCounts, mine = G().my.role;
  const items = ROLE_ORDER.filter(k=>cnt[k]).map(k=>{
    const r = ROLES[k];
    return `<div class="gi ${k===mine?"me":""}"><span class="pill ${r.team}">${r.team==="g"?"선":"악"}</span> <b>${r.name}</b>${cnt[k]>1?` ×${cnt[k]}`:""}${k===mine?' <span class="crown">← 나</span>':""}<br><span class="muted">${roleDesc(k)}</span></div>`;
  }).join("");
  return `<div class="card"><h2>이번 게임 역할 설명</h2><div class="guide">${items}</div></div>`;
}

function logCard(){
  const log = G().log;
  if(!log.length) return "";
  return `<details class="card"><summary><b>기록</b> (${log.length})</summary><div class="log" style="margin-top:8px">${log.slice().reverse().map(esc).join("<br>")}</div></details>`;
}

// 각 플레이어 상태 줄 (✓ 표시 등)
function playerChips(mark){
  return `<div class="chips">${S.players.map((p,i)=>{
    const m = mark(i);
    return `<span class="chip ${m?"done":""} ${p.connected?"":"off"}">${i===G().leader?"👑":""}${esc(p.name)}${m?" ✓":""}${p.connected?"":" 📵"}</span>`;
  }).join("")}</div>`;
}

function vMenu(){
  const host = isHost();
  return `<div class="card">
    <h2>메뉴</h2>
    <button data-act="menuClose">← 게임으로 돌아가기</button>
    <div class="gap"></div>
    ${host ? `
    <button class="menubtn" data-act="againAsk">🔄 역할 다시 뽑기<span class="s">같은 멤버·같은 설정으로 처음부터</span></button>
    <div class="gap"></div>
    <button class="evil menubtn" data-act="toLobbyAsk">🏠 게임 종료 · 로비로<span class="s">인원·순서·역할 설정부터 다시</span></button>`
    : `<div class="muted center">다시 하기나 게임 종료는 방장(${esc((S.players.find(p=>p.id===S.hostId)||{}).name||"")})만 할 수 있어요.</div>`}
  </div>
  ${roleGuide()}`;
}

function waitLine(text){ return `<div class="wait"><span class="spin"></span>${text}</div>`; }

// ---------- 화면 ----------
function vHome(){
  return `
  <h1>🗡️ 원탁</h1>
  <div class="sub">각자 자기 폰으로 하는 정체 숨기기 게임</div>
  ${ui.notice?`<div class="card center muted">${esc(ui.notice)}</div>`:""}
  <div class="card">
    <h2>내 이름</h2>
    <input type="text" id="name" placeholder="이름 (10자 이내)" maxlength="10" value="${esc(ui.name)}" autocomplete="off">
  </div>
  <div class="card">
    <h2>방에 들어가기</h2>
    <input type="text" id="code" inputmode="numeric" pattern="[0-9]*" placeholder="방 코드 4자리" maxlength="4" value="${esc(ui.code)}" autocomplete="off" class="codein">
    <div class="gap"></div>
    <button class="${ui.code?"primary":""}" data-act="join" ${ui.busy?"disabled":""}>입장하기</button>
  </div>
  <div class="card">
    <h2>새 방 만들기</h2>
    <div class="muted" style="margin-bottom:10px">방을 만들면 코드와 링크(QR)를 친구들에게 보여주세요.</div>
    <button class="${ui.code?"":"primary"}" data-act="create" ${ui.busy?"disabled":""}>방 만들기</button>
  </div>
  ${ui.error?`<div class="err">${esc(ui.error)}</div>`:""}`;
}

function joinUrl(){ return `${location.origin}/?room=${S.code}`; }

function vLobby(){
  const n = S.players.length, host = isHost();
  const ok = n>=5 && n<=10;
  const rows = S.players.map((p,i)=>`
    <div class="prow">
      <span class="seat">${i+1}</span>
      <span class="pn">${esc(p.name)}${p.id===S.hostId?' <span class="pill">방장</span>':""}${p.id===S.me.id?' <span class="crown">(나)</span>':""}${p.connected?"":' <span class="muted">📵</span>'}</span>
      ${host?`<span class="ctl">
        <button class="small" data-act="move" data-id="${p.id}" data-d="-1" ${i===0?"disabled":""}>▲</button>
        <button class="small" data-act="move" data-id="${p.id}" data-d="1" ${i===n-1?"disabled":""}>▼</button>
        ${p.id!==S.me.id?`<button class="small" data-act="hostMenu" data-id="${p.id}">⋯</button>`:""}
      </span>`:""}
    </div>`).join("");

  const tog = (k,t,d) => `<div class="toggle ${S.opts[k]?"on":""} ${host?"":"ro"}" ${host?`data-opt="${k}"`:""}><div><div class="t">${t}</div><div class="d">${d}</div></div><div class="sw"></div></div>`;
  let roleSec = "";
  if(ok){
    const evilN = EVIL_COUNT[n];
    const items = RECOMMEND[n].map((r,idx)=>{
      const t = comboText(n, r.opts), applied = sameOpts(S.opts, r.opts);
      return `<div class="preset ${applied?"on":""}" ${host?`data-act="applyRec" data-i="${idx}"`:""}>
        <div class="row" style="justify-content:space-between"><b>${r.label}</b><span class="muted">${applied?"✓ 적용됨":host?"탭해서 적용":""}</span></div>
        <div><span style="color:#9cc2ff">선 ${n-evilN}</span> ${t.good}</div>
        <div><span style="color:#ff9a9d">악 ${evilN}</span> ${t.evil}</div>
      </div>`;
    }).join("");
    roleSec = `<div class="center muted" style="margin-bottom:10px">선 <b style="color:#9cc2ff">${n-evilN}</b> · 악 <b style="color:#ff9a9d">${evilN}</b> &nbsp;|&nbsp; 원정 인원 ${TEAM_SIZES[n].join("-")}${n>=7?" (4번째는 실패 2장 필요)":""}</div>
      <div class="rec"><div class="tag">⭐ ${n}인 추천 조합${RECOMMEND[n].length>1?" (택 1)":""}</div>${items}</div>`;
  } else {
    roleSec = `<div class="center muted" style="margin-bottom:10px">5~10명이 모이면 추천 조합이 나와요. (지금 ${n}명)</div>`;
  }

  return `
  <div class="card center">
    <div class="muted">방 코드</div>
    <div class="code">${S.code}</div>
    <div id="qr"></div>
    <div class="muted" style="word-break:break-all;margin:8px 0">${esc(joinUrl())}</div>
    <button class="small" data-act="share">🔗 링크 공유/복사</button>
  </div>
  <div class="card">
    <h2>참가자 ${n}명 <span class="muted">(앉은 순서대로${host?" · ▲▼로 조정":""})</span></h2>
    <div>${rows}</div>
  </div>
  <div class="card">
    <h2>역할 ${host?"":'<span class="muted">(방장이 정해요)</span>'}</h2>
    ${roleSec}
    <div class="muted" style="margin-bottom:10px">멀린과 암살자는 항상 포함</div>
    ${tog("percival","퍼시벌 (선)","멀린을 알아보는 기사")}
    ${tog("morgana","모르가나 (악)","퍼시벌에게 멀린처럼 보임")}
    ${tog("mordred","모드레드 (악)","멀린에게 안 보임")}
    ${tog("oberon","오베론 (악)","악끼리 서로 모름")}
  </div>
  <div class="card">
    <h2>찬반 투표 방식</h2>
    <div class="row">
      <button class="${!S.secretVote?"primary":""}" ${host?'data-act="voteMode" data-v="0"':'data-ro="1"'}>✋ 공개</button>
      <button class="${S.secretVote?"primary":""}" ${host?'data-act="voteMode" data-v="1"':'data-ro="1"'}>🤫 비밀</button>
    </div>
    <div class="muted" style="margin-top:8px">${S.secretVote
      ? "찬반 개수만 공개되고, 누가 뭘 냈는지는 비밀이에요."
      : "누가 찬성/반대했는지 모두에게 공개돼요. (원래 규칙)"}</div>
  </div>
  ${ui.error?`<div class="err">${esc(ui.error)}</div>`:""}
  <div class="gap"></div>
  ${host
    ? `<button class="primary" data-act="start" ${ok?"":"disabled"}>게임 시작 →</button>`
    : waitLine("방장이 게임을 시작하길 기다리는 중…")}
  <div class="gap"></div>
  <button class="ghost" data-act="leave">방 나가기</button>`;
}

function vReveal(){
  const g = G(), done = g.revealed[meIdx()], cnt = g.revealed.filter(Boolean).length;
  let main;
  if(!done && !ui.roleOpen){
    main = `<div class="pass">
      <div>${esc(S.me.name)}님의 역할이 정해졌어요</div>
      <div class="muted">다른 사람이 화면을 보지 않게 하세요</div>
      <button class="cover" data-act="roleShow">👆<br>탭해서 내 역할 보기</button>
    </div>`;
  } else if(!done){
    main = `<div class="pass">
      ${roleCard()}
      <button class="primary" data-act="revealOk">확인 완료</button>
      <div class="muted">누르면 역할이 바로 가려져요 (게임 중 다시 볼 수 있어요)</div>
    </div>`;
  } else {
    main = `<div class="card center">
      <h2>✓ 확인 완료</h2>
      ${waitLine(`다른 사람들이 역할을 확인하는 중… (${cnt}/${g.count})`)}
    </div>${myRoleBox()}`;
  }
  return `${main}
    <div class="card"><h2>역할 확인 ${cnt}/${g.count}</h2>${playerChips(i=>g.revealed[i])}</div>
    ${roleGuide()}`;
}

function vTeam(){
  const g = G(), need = TEAM_SIZES[g.count][g.questIdx], lead = isLeader();
  const btns = S.players.map((p,i)=>`<button class="pbtn ${g.team.includes(i)?"sel":""}" ${lead?`data-act="pick" data-i="${i}"`:'tabindex="-1"'} ${lead?"":'data-ro="1"'}>${i===g.leader?'<span class="crown">👑</span> ':""}${esc(p.name)}${i===meIdx()?" (나)":""}</button>`).join("");
  return `${board()}
  <div class="card ${lead?"turn":""}">
    <h2>${g.questIdx+1}번째 원정 · 팀 구성</h2>
    <div class="muted" style="margin-bottom:12px">${lead
      ? `<b class="crown">당신이 대표예요!</b> 원정대 <b>${need}명</b>을 고르세요. (${g.team.length}/${need})`
      : `대표 <b class="crown">👑 ${pname(g.leader)}</b>님이 원정대 <b>${need}명</b>을 고르는 중… (${g.team.length}/${need})`}</div>
    <div class="plist">${btns}</div>
    ${lead?`<div class="gap"></div><button class="primary" data-act="propose" ${g.team.length!==need?"disabled":""}>이 팀으로 투표 올리기</button>`:""}
    ${g.rejects===4?`<div class="err">⚠️ 이번에 부결되면 악이 승리합니다!</div>`:""}
  </div>
  ${ui.error?`<div class="err">${esc(ui.error)}</div>`:""}
  ${myRoleBox()}${logCard()}`;
}

function teamPills(team){ return team.map(i=>`<span class="pill">${pname(i)}</span>`).join(" "); }

function vVote(){
  const g = G(), v = g.my.vote, cnt = g.voted.filter(Boolean).length;
  return `${board()}
  <div class="card center ${v===null?"turn":""}">
    <h2>원정대 찬반 투표 ${g.secretVote?"🤫":"✋"}</h2>
    <div class="muted" style="margin-bottom:6px">👑 ${pname(g.leader)}님의 제안</div>
    <div class="row wrap" style="justify-content:center;margin-bottom:12px">${teamPills(g.team)}</div>
    ${g.rejects===4?`<div class="err" style="margin-bottom:10px">⚠️ 이번에 부결되면 악이 승리합니다!</div>`:""}
    <div class="row">
      <button class="good ${v===true?"chosen":""} ${v===false?"dim":""}" data-act="vote" data-v="1" style="padding:24px;font-size:20px">👍 찬성</button>
      <button class="evil ${v===false?"chosen":""} ${v===true?"dim":""}" data-act="vote" data-v="0" style="padding:24px;font-size:20px">👎 반대</button>
    </div>
    <div class="muted" style="margin-top:10px">${v===null?"과반수(동수는 부결)가 찬성하면 가결입니다.":"투표했어요. 모두 낼 때까지 바꿀 수 있어요."}
      ${g.secretVote?"<br>누가 뭘 냈는지는 공개되지 않아요.":"<br>결과에서 각자 뭘 냈는지 공개돼요."}</div>
  </div>
  <div class="card"><h2>투표 ${cnt}/${g.count}</h2>${playerChips(i=>g.voted[i])}</div>
  ${isLeader() && cnt===0?`<button class="ghost" data-act="cancelProposal">← 제안 취소하고 팀 다시 고르기</button><div class="gap"></div>`:""}
  ${myRoleBox()}`;
}

function canAdvance(){ return isHost() || isLeader(); }
function nextBtn(label){
  return canAdvance() ? `<button class="primary" data-act="next">${label||"계속"}</button>`
                      : waitLine(`대표 👑 ${pname(G().leader)}님이 넘기길 기다리는 중…`);
}

function vVoteResult(){
  const g = G(), r = g.lastVote;
  const detail = r.detail ? `<div class="vgrid">${S.players.map((p,i)=>`<div class="vcell ${r.detail[i]?"y":"n"}">${r.detail[i]?"👍":"👎"} ${esc(p.name)}</div>`).join("")}</div>`
                          : `<div class="muted">누가 어디에 투표했는지는 공개되지 않아요.</div>`;
  return `${board()}
  <div class="card center">
    <h2>찬반 투표 결과</h2>
    <div class="row wrap" style="justify-content:center;margin-bottom:6px">${teamPills(r.team)}</div>
    <div class="row" style="justify-content:center;gap:24px;margin:6px 0">
      <div><div class="big" style="color:#9cc2ff">${r.yes}</div><div class="muted">👍 찬성</div></div>
      <div><div class="big" style="color:#ff9a9d">${r.no}</div><div class="muted">👎 반대</div></div>
    </div>
    <div class="big" style="color:${r.pass?"#9cc2ff":"#ff9a9d"}">${r.pass?"가결!":"부결!"}</div>
    ${detail}
    <div class="gap"></div>
    ${nextBtn(r.pass?"원정 출발 →":"다음 대표에게 →")}
  </div>
  ${myRoleBox()}`;
}

function vQuest(){
  const g = G(), me = meIdx(), onTeam = g.team.includes(me), mv = g.my.questVote;
  const done = g.questDone.filter(Boolean).length;
  let main;
  if(onTeam && mv===null){
    const good = ROLES[g.my.role].team === "g";
    main = `<div class="card center turn">
      <h2>원정 카드를 내세요</h2>
      <div class="muted" style="margin-bottom:12px">${good?"선의 세력은 성공만 낼 수 있어요.":"악의 세력은 성공/실패 중 고를 수 있어요."}<br>다른 사람이 화면을 보지 않게 하세요.</div>
      <button class="good" data-act="quest" data-v="s" style="padding:28px;font-size:22px">✓ 성공</button>
      <div class="gap"></div>
      <button class="evil" data-act="quest" data-v="f" style="padding:28px;font-size:22px" ${good?"disabled":""}>✗ 실패</button>
    </div>`;
  } else {
    main = `<div class="card center">
      <h2>${g.questIdx+1}번째 원정 진행 중</h2>
      ${onTeam?`<div style="margin-bottom:8px">✓ 카드를 냈어요</div>`:""}
      ${waitLine(`원정대가 카드를 내는 중… (${done}/${g.team.length})`)}
    </div>`;
  }
  const chips = `<div class="chips">${g.team.map((i,k)=>`<span class="chip ${g.questDone[k]?"done":""}">${pname(i)}${g.questDone[k]?" ✓":""}</span>`).join("")}</div>`;
  return `${board()}${main}
  <div class="card"><h2>원정대</h2>${chips}</div>
  ${ui.error?`<div class="err">${esc(ui.error)}</div>`:""}
  ${myRoleBox()}`;
}

function vQuestResult(){
  const g = G(), r = g.lastQuest;
  const anim = ui.animQuest !== r.idx; ui.animQuest = r.idx;
  const cards = r.cards.map((v,i)=>`<div class="rc ${v} ${anim?"anim":""}" style="animation-delay:${i*0.25}s">${v==="s"?"✓":"✗"}</div>`).join("");
  return `${board()}
  <div class="card center">
    <h2>${r.idx+1}번째 원정 결과</h2>
    <div class="row wrap" style="justify-content:center">${teamPills(g.quests[r.idx].team)}</div>
    <div class="results">${cards}</div>
    <div class="big" style="color:${r.result==="s"?"#9cc2ff":"#ff9a9d"}">${r.result==="s"?"원정 성공!":"원정 실패!"}</div>
    <div class="muted">실패 카드 ${r.fails}장${r.idx===3&&g.count>=7?" (이번 원정은 2장 이상이어야 실패)":""}</div>
    <div class="gap"></div>
    ${nextBtn()}
  </div>
  ${myRoleBox()}${logCard()}`;
}

function vAssassin(){
  const g = G(), me = meIdx(), asn = g.assassin, amA = me === asn;
  const btns = S.players.map((p,i)=>i===asn?"":`<button class="pbtn ${g.assassinTarget===i?"sel":""}" ${amA?`data-act="aim" data-i="${i}"`:'data-ro="1"'}>${esc(p.name)}</button>`).join("");
  return `${board()}
  <div class="banner e">
    <div class="big">🗡️ 암살 시간</div>
    <div>선이 원정 3번을 성공했습니다.<br>악의 세력은 정체를 밝히고 상의한 뒤,<br>암살자 <b>${pname(asn)}</b>님이 멀린을 지목하세요.</div>
  </div>
  <div class="card ${amA?"turn":""}">
    ${amA?`<h2>멀린이라고 생각하는 사람을 고르세요</h2>`:`<div class="muted" style="margin-bottom:10px">암살자가 고르는 중… (선택이 실시간으로 보여요)</div>`}
    <div class="plist">${btns}</div>
    ${amA?`<div class="gap"></div><button class="evil" data-act="kill" ${g.assassinTarget==null?"disabled":""}>이 사람을 암살</button>`:""}
  </div>
  ${myRoleBox()}`;
}

function vEnd(){
  const g = G(), win = g.winner === "g";
  const rows = S.players.map((p,i)=>{
    const r = ROLES[g.roles[i]];
    return `<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
      <b>${esc(p.name)}${i===meIdx()?' <span class="crown">(나)</span>':""}</b><span class="pill ${r.team}">${r.name}</span></div>`;
  }).join("");
  return `<div class="banner ${win?"g":"e"}">
    <div class="big">${win?"🛡️ 선의 승리!":"🗡️ 악의 승리!"}</div>
    <div>${esc(g.reason)}</div>
  </div>
  ${board()}
  <div class="card"><h2>정체 공개</h2>${rows}</div>
  ${logCard()}
  ${isHost()
    ? `<button class="primary" data-act="again">같은 멤버로 다시 (역할 새로)</button><div class="gap"></div>
       <button class="ghost" data-act="toLobby">로비로 (인원/설정 바꾸기)</button>`
    : waitLine("방장이 다음 게임을 준비하는 중…")}`;
}

const NO_MENU = ["lobby","end"];
const VIEWS = {lobby:vLobby, reveal:vReveal, team:vTeam, vote:vVote, voteResult:vVoteResult, quest:vQuest, questResult:vQuestResult, assassin:vAssassin, end:vEnd};

function render(){
  // 홈 화면 입력 중이면 값 보존
  const nameEl = document.getElementById("name"), codeEl = document.getElementById("code");
  if(nameEl) ui.name = nameEl.value;
  if(codeEl) ui.code = codeEl.value;
  const focused = document.activeElement && document.activeElement.id;

  let html;
  if(ui.replaced) html = `<div class="pass"><div>다른 탭(또는 기기)에서 같은 자리로 접속했어요.</div><button class="primary" data-act="reclaim">여기서 계속하기</button></div>`;
  else if(session && !S) html = `<div class="pass">${waitLine(ui.connected?"방에 다시 들어가는 중…":"서버에 연결하는 중…")}<button class="ghost" data-act="forget">처음 화면으로</button></div>`;
  else if(!S) html = vHome();
  else if(ui.menuOpen && !NO_MENU.includes(S.phase)) html = vMenu();
  else html = (NO_MENU.includes(S.phase) ? "" : `<div class="topbar"><button class="small ghost" data-act="menuOpen">☰ 메뉴 · 다시하기</button></div>`)
            + (VIEWS[S.phase] || vLobby)();
  const bar = !ui.connected && !ui.replaced ? `<div class="conn">📡 연결이 끊겼어요. 다시 연결하는 중…</div>` : "";
  $app.innerHTML = bar + html;

  if(focused){ const el = document.getElementById(focused); if(el){ el.focus(); const v=el.value; el.value=""; el.value=v; } }
  if(S && S.phase === "lobby") drawQr();
}

function drawQr(){
  const box = document.getElementById("qr");
  if(box) box.innerHTML = `<img src="/qr.svg?u=${encodeURIComponent(joinUrl())}" width="168" height="168" alt="입장 QR 코드">`;
}

// ---------- 입력 ----------
function needName(){
  const n = (document.getElementById("name").value || "").trim();
  if(!n){ ui.error = "이름을 먼저 입력해 주세요."; render(); return null; }
  ui.name = n; LS.set("roundtable-spy-name", n);
  return n;
}
const ACT = {
  create(){
    const n = needName(); if(!n) return;
    if(!ui.connected){ ui.error = "서버에 연결하는 중이에요. 잠시 후 다시 눌러 주세요."; render(); return; }
    ui.busy = true; ui.notice = null; act({t:"create", name:n}); render();
  },
  join(){
    const n = needName(); if(!n) return;
    const c = (document.getElementById("code").value || "").replace(/\D/g,"");
    if(c.length !== 4){ ui.error = "방 코드 4자리를 입력해 주세요."; render(); return; }
    if(!ui.connected){ ui.error = "서버에 연결하는 중이에요. 잠시 후 다시 눌러 주세요."; render(); return; }
    ui.busy = true; ui.notice = null; act({t:"join", code:c, name:n}); render();
  },
  forget(){ leaveLocal(); },
  reclaim(){ ui.replaced = false; session = LS.get(SESSION_KEY) || session; connect(); render(); },
  leave(){ if(confirm("방에서 나갈까요?")) act({t:"leave"}); },
  share(){
    const url = joinUrl();
    if(navigator.share){ navigator.share({title:"원탁", text:`방 코드 ${S.code}`, url}).catch(()=>{}); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(()=>alert("링크를 복사했어요!"), ()=>prompt("이 링크를 복사하세요", url));
  },
  move(el){ act({t:"move", id:el.dataset.id, d:+el.dataset.d}); },
  hostMenu(el){
    const p = S.players.find(x=>x.id===el.dataset.id); if(!p) return;
    const c = prompt(`${p.name}님:\n1 = 방에서 내보내기\n2 = 방장 넘기기`, "");
    if(c === "1" && confirm(`${p.name}님을 내보낼까요?`)) act({t:"kick", id:p.id});
    else if(c === "2" && confirm(`${p.name}님에게 방장을 넘길까요?`)) act({t:"makeHost", id:p.id});
  },
  applyRec(el){ act({t:"setOpts", preset:true, opts:RECOMMEND[S.players.length][+el.dataset.i].opts}); },
  voteMode(el){ act({t:"setVoteMode", secret:el.dataset.v==="1"}); },
  start(){ act({t:"start"}); },
  roleShow(){ ui.roleOpen = true; render(); },
  roleHide(){ ui.roleOpen = false; render(); },
  revealOk(){ ui.roleOpen = false; act({t:"revealOk"}); render(); },
  pick(el){ act({t:"pick", i:+el.dataset.i}); },
  propose(){ act({t:"propose"}); },
  cancelProposal(){ act({t:"cancelProposal"}); },
  vote(el){ act({t:"vote", v:el.dataset.v==="1"}); },
  next(){ act({t:"next"}); },
  quest(el){
    if(el.dataset.v==="f" && !confirm("실패 카드를 낼까요?")) return;
    act({t:"quest", v:el.dataset.v});
  },
  aim(el){ act({t:"aim", i:+el.dataset.i}); },
  kill(){ if(confirm(`${S.players[G().assassinTarget].name}님을 암살할까요? 되돌릴 수 없어요.`)) act({t:"kill"}); },
  again(){ act({t:"again"}); },
  toLobby(){ act({t:"toLobby"}); },
  toLobbyAsk(){ if(confirm("정말 게임을 끝내고 모두 로비로 돌아갈까요?")) { ui.menuOpen=false; act({t:"toLobby"}); } },
  againAsk(){ if(confirm("역할을 새로 뽑아서 처음부터 다시 할까요?")) { ui.menuOpen=false; act({t:"again"}); } },
  menuOpen(){ ui.menuOpen = true; ui.roleOpen = false; render(); window.scrollTo(0,0); },
  menuClose(){ ui.menuOpen = false; render(); window.scrollTo(0,0); }
};

$app.addEventListener("click", e=>{
  const opt = e.target.closest("[data-opt]");
  if(opt){ const o = Object.assign({}, S.opts); o[opt.dataset.opt] = o[opt.dataset.opt] ? 0 : 1; act({t:"setOpts", opts:o}); return; }
  const el = e.target.closest("[data-act]");
  if(el && !el.disabled && ACT[el.dataset.act]) ACT[el.dataset.act](el);
});
$app.addEventListener("input", e=>{
  if(e.target.id === "code"){ e.target.value = e.target.value.replace(/\D/g,"").slice(0,4); ui.code = e.target.value; }
  if(e.target.id === "name") ui.name = e.target.value;
});
$app.addEventListener("keydown", e=>{
  if(e.key !== "Enter") return;
  if(e.target.id === "code") ACT.join();
  else if(e.target.id === "name") (ui.code ? ACT.join : ACT.create)();
});

render();
connect();
})();

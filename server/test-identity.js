// 身份 + 幂等投票 端到端回归测试
// 运行：node server/test-identity.js
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-fixed';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitEvent(sock, ev, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const h = (data) => { clearTimeout(t); sock.off(ev, h); resolve(data); };
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error('timeout: ' + ev)); }, timeout);
    sock.on(ev, h);
  });
}
const connect = () => io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
const postVote = async (body) => {
  const r = await fetch(BASE + '/api/vote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
};

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, PORT: String(PORT), EDEN_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  child.stdout.on('data', d => process.stdout.write('[server] ' + d));

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) { ready = true; break; } } catch (e) { }
    await sleep(200);
  }
  if (!ready) { console.error('server not ready'); child.kill(); process.exit(1); }

  try {
    console.log('\n=== 身份：加入 / token 重连 / 防幽灵 ===');
    const admin = connect();
    await waitEvent(admin, 'connect');
    admin.emit('joinAdmin');

    const s1 = connect();
    await waitEvent(s1, 'connect');
    s1.emit('joinGame', { name: '甲' });
    const j1 = await waitEvent(s1, 'joinSuccess');
    check('加入返回 playerId 与 token', !!j1.playerId && !!j1.token);

    // 模拟页面刷新：断开旧连接，用同一 token 重新连接
    s1.disconnect();
    await sleep(150);
    const s1b = connect();
    await waitEvent(s1b, 'connect');
    const plPromise = waitEvent(admin, 'playerListUpdate');
    s1b.emit('identify', { token: j1.token });
    const j1b = await waitEvent(s1b, 'joinSuccess');
    check('token 重连命中同一 playerId（不产生幽灵）', j1b.playerId === j1.playerId);
    check('重连标记 reconnected=true', j1b.reconnected === true);
    check('编号保持不变', j1b.num === j1.num);
    const pl = await plPromise;
    check('刷新重连后玩家总数仍为 1', pl.count === 1, pl);

    // 伪造 token 必须被拒
    const bad = connect();
    await waitEvent(bad, 'connect');
    bad.emit('identify', { token: 'not.a.token' });
    const badRes = await waitEvent(bad, 'identifyFailed');
    check('伪造 token 被拒绝', badRes.reason === 'BAD_TOKEN');

    // 第二个玩家加入
    const s2 = connect();
    await waitEvent(s2, 'connect');
    s2.emit('joinGame', { name: '乙' });
    const j2 = await waitEvent(s2, 'joinSuccess');

    // 顶号：用同一 token 再开新连接，旧连接应被踢
    const s1c = connect();
    await waitEvent(s1c, 'connect');
    const kickedP = waitEvent(s1b, 'kicked', 3000).catch(() => null);
    s1c.emit('identify', { token: j1.token });
    const j1c = await waitEvent(s1c, 'joinSuccess');
    const kicked = await kickedP;
    check('同一身份新连接会顶掉旧连接', !!kicked);
    check('顶号后身份仍是甲', j1c.playerId === j1.playerId && j1c.num === j1.num);

    console.log('\n=== 幂等投票 ===');
    const disp = connect();
    await waitEvent(disp, 'connect');
    const voteUpdates = [];
    disp.on('voteUpdate', d => voteUpdates.push(d));
    disp.emit('joinDisplay');
    await waitEvent(disp, 'gameStateSync');

    const gs1 = waitEvent(s1c, 'gameStart');
    const gs2 = waitEvent(s2, 'gameStart');
    admin.emit('adminStartGame');
    await gs1;
    await gs2;

    const v1 = await postVote({ token: j1.token, round: 1, choice: 'gold', betAmount: 0, clientVoteId: 'cid-A' });
    check('首次投票成功', v1.ok === true, v1);

    const v2 = await postVote({ token: j1.token, round: 1, choice: 'gold', betAmount: 0, clientVoteId: 'cid-A-dup' });
    check('重复提交返回首次回执（duplicate）', v2.ok === true && v2.duplicate === true, v2);
    check('重复提交未改变选择', v2.choice === 'gold');

    const roundEndP = waitEvent(disp, 'roundEnd');
    const v3 = await postVote({ token: j2.token, round: 1, choice: 'silver', betAmount: 0, clientVoteId: 'cid-B' });
    check('第二玩家投票成功', v3.ok === true);

    const roundEnd = await roundEndP;
    check('重复票未重复计票：gold 应为 1 而非 2', roundEnd.result.votes.gold === 1, roundEnd.result.votes);
    check('silver 计为 1', roundEnd.result.votes.silver === 1);
    check('两票投完自动结算（status=result）', true);

    console.log('\n=== 结算补偿：结算阶段重连能拉回本轮结果 ===');
    await sleep(200);
    const s1d = connect();
    await waitEvent(s1d, 'connect');
    const myResultP = waitEvent(s1d, 'myResult', 4000).catch(() => null);
    s1d.emit('identify', { token: j1.token });
    await waitEvent(s1d, 'joinSuccess');
    const myResult = await myResultP;
    check('结算阶段重连收到 myResult（补偿成功）', !!myResult, myResult);
    check('myResult 记录了正确选择', myResult && myResult.choice === 'gold', myResult);

    console.log('\n=== 重置后旧 token 失效（跨局不串号）===');
    admin.emit('adminResetGame');
    await sleep(300);
    const s1e = connect();
    await waitEvent(s1e, 'connect');
    s1e.emit('identify', { token: j1.token });
    const stale = await waitEvent(s1e, 'identifyFailed');
    check('重置后旧 token 失效', stale.reason === 'STALE_TOKEN', stale);

  } catch (e) {
    fail++;
    console.error('  EXCEPTION', e && e.message);
  } finally {
    child.kill();
    await sleep(200);
  }

  console.log(`\n==== 结果: ${pass} 通过 / ${fail} 失败 ====`);
  process.exit(fail === 0 ? 0 : 1);
})();
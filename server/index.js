const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

// 静态文件服务
app.use('/display', express.static(path.join(__dirname, '../client/display')));
app.use('/admin', express.static(path.join(__dirname, '../client/admin')));
app.use('/player', express.static(path.join(__dirname, '../client/player')));

// 健康检查（Render 需要）
app.get('/', (req, res) => {
  res.redirect('/display/');
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 获取本机局域网IP（本地使用）
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// ==================== 身份令牌 ====================
// token = playerId.gameId.hmac —— 服务端签发，客户端只持有、不解析。
// gameId 每次「重置游戏 / 服务端重启」都会重新生成，旧 token 自动失效，
// 从根本上杜绝「上一局的手机串进新一局」。
const SECRET_FILE = path.join(__dirname, '../.eden-secret');
let SECRET = process.env.EDEN_SECRET;
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* 首次运行 */ }
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, SECRET); } catch (e) { /* 无写权限时退化为内存密钥 */ }
  }
}

let gameId = crypto.randomBytes(8).toString('hex');

function signToken(playerId, gid) {
  const payload = `${playerId}.${gid}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [playerId, gid, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${playerId}.${gid}`).digest('hex');
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) {
    return null;
  }
  return { playerId, gameId: gid };
}

// ==================== 游戏常量 ====================
const INITIAL_SCORE = 10000;
const WIN_REWARD = 1000;
const LOSE_PENALTY = 2000;
const NO_VOTE_PENALTY = 2000;  // 未投票扣分
const ROUND_TIME = 60;
const TOTAL_ROUNDS = 8;
const WIN_COUNT = 10;  // ★ 默认前N名获胜

// ==================== 编号管理 ====================
let nextPlayerNum = 1;
function assignPlayerNum() {
  return nextPlayerNum++;
}

// ==================== 游戏状态 ====================
let gameState = {
  status: 'waiting',   // waiting | voting | result | gameover
  round: 0,
  totalRounds: TOTAL_ROUNDS,
  winCount: WIN_COUNT,  // ★ 前N名获胜
  players: {},         // { playerId: { playerId, name, num, score, eliminated, voted, voteChoice, betAmount, socketId, connected } }
  votes: { red: 0, gold: 0, silver: 0 },
  timer: ROUND_TIME,
  roundResult: null,
  roundHistory: [],
  lastResults: {},     // { playerId: myResult } —— 结算补偿，重连可拉回本轮结果
  publicUrl: ''
};

// 幂等投票账本：{ `${playerId}:${round}`: { clientVoteId, choice, betAmount, ack } }
// 同一轮重复提交（网络重试 / 断网补投）永远返回首次回执，绝不重复计票。
let voteLedger = {};

let timerInterval = null;

// ==================== 玩家查找 ====================
function getPlayerBySocket(socketId) {
  for (const pid in gameState.players) {
    if (gameState.players[pid].socketId === socketId) return gameState.players[pid];
  }
  return null;
}

// ==================== 有效玩家（未淘汰）====================
function getActivePlayers() {
  return Object.values(gameState.players).filter(p => !p.eliminated);
}

function getActivePlayerCount() {
  return getActivePlayers().length;
}

// ==================== 规则计算 ====================

/**
 * 第1-7轮规则（少数派获胜）：
 *
 * 有人投红时：
 *   - 红 < 金 且 红 < 银（红最少）→ 红+1000，金-2000，银-2000
 *   - 金或银任意一个 ≤ 红（即红不是最少）→ 金银阵营赢：金+1000，银+1000，红-2000
 *
 * 无人投红（仅金 vs 银）：
 *   - 金 < 银 → 金+1000，银-2000
 *   - 银 < 金 → 银+1000，金-2000
 *   - 金 = 银 → 全员-2000
 *
 * 全员投红 → 全体胜利
 */
function calcNormalRound(votes) {
  const { red, gold, silver } = votes;
  const total = red + gold + silver;

  // 特殊：全员投红
  if (red === total && total > 0) {
    return { specialEvent: 'all_red', winners: [], losers: [], message: '🎉 全员选择红苹果 — 全体胜利！游戏提前结束！' };
  }

  // 无人投红：仅金 vs 银
  if (red === 0) {
    if (gold === 0 && silver === 0) {
      return { winners: [], losers: ['gold', 'silver'], message: '无人投票，全员扣分' };
    }
    if (gold === silver) {
      return { winners: [], losers: ['gold', 'silver'], message: `金苹果 = 银苹果（各 ${gold} 人），平局全员扣除 ${LOSE_PENALTY} 积分` };
    }
    if (gold < silver) {
      return { winners: ['gold'], losers: ['silver'], message: `金苹果（${gold}人）少于银苹果（${silver}人）→ 金苹果少数派胜！金+${WIN_REWARD}，银-${LOSE_PENALTY}` };
    }
    return { winners: ['silver'], losers: ['gold'], message: `银苹果（${silver}人）少于金苹果（${gold}人）→ 银苹果少数派胜！银+${WIN_REWARD}，金-${LOSE_PENALTY}` };
  }

  // 有人投红时
  if (red < gold && red < silver) {
    return { winners: ['red'], losers: ['gold', 'silver'], message: `红苹果（${red}人）最少 → 红苹果胜！红+${WIN_REWARD}，金-${LOSE_PENALTY}，银-${LOSE_PENALTY}` };
  }

  // ★ 金或银任意一个 ≤ 红 → 金银阵营整体获胜
  // 同票数时：如果金=银=红，按普通轮规则红不是最少，金银胜
  // 如果金=红且银>红，金≤红成立，金银阵营胜
  return {
    winners: ['gold', 'silver'],
    losers: ['red'],
    message: `金银阵营（金${gold}人、银${silver}人）中有一方少于红苹果（${red}人）→ 金银阵营胜！金+${WIN_REWARD}，银+${WIN_REWARD}，红-${LOSE_PENALTY}`
  };
}

/**
 * 最终轮规则（★ 修复同票数判定漏洞）：
 * - 红票数 >= (总票数 - 10) → 全体胜利
 * - 有红苹果时：最少者获胜；金=银同为最少 → 金银阵营共同胜利
 * - 无红苹果时：金 vs 银，金=银 → 金银同时失败（全员扣分）
 * - 三色同票 → 全员扣分
 * - 红与另一色同票且同为最少 → 红优先（冒险者胜）
 */
function calcFinalRound(votes) {
  const { red, gold, silver } = votes;
  const total = red + gold + silver;

  if (total > 0 && red >= total - 10) {
    return { specialEvent: 'all_red', winners: [], losers: [], message: `🎉 红苹果（${red}人）≥ 总票数（${total}）- 10 → 全体胜利！` };
  }

  // ★ 无红苹果：金 vs 银
  if (red === 0) {
    if (gold === 0 && silver === 0) {
      return { winners: [], losers: ['gold', 'silver'], message: `无人投票 → 全员扣除 ${LOSE_PENALTY} 积分` };
    }
    if (gold === silver) {
      // ★ 无红苹果时，金=银 → 金银同时失败
      return { winners: [], losers: ['gold', 'silver'], message: `无红苹果，金=银（各${gold}人）→ 金银同时失败，全员扣除 ${LOSE_PENALTY} 积分` };
    }
    if (gold < silver) {
      return { winners: ['gold'], losers: ['silver'], message: `无红苹果，金苹果（${gold}人）< 银苹果（${silver}人）→ 金+${WIN_REWARD}，银-${LOSE_PENALTY}` };
    }
    return { winners: ['silver'], losers: ['gold'], message: `无红苹果，银苹果（${silver}人）< 金苹果（${gold}人）→ 银+${WIN_REWARD}，金-${LOSE_PENALTY}` };
  }

  // ★ 三色完全相同 → 全员扣分
  if (red === gold && gold === silver) {
    return { winners: [], losers: ['red', 'gold', 'silver'], message: `三色人数完全相同（各${red}人）→ 全员扣除 ${LOSE_PENALTY} 积分` };
  }

  // ★ 找最少值
  const minVal = Math.min(red, gold, silver);
  const isMinRed = red === minVal;
  const isMinGold = gold === minVal;
  const isMinSilver = silver === minVal;

  // ★ 只有一种最少
  if (isMinRed && !isMinGold && !isMinSilver) {
    return { winners: ['red'], losers: ['gold', 'silver'], message: `红苹果（${red}人）最少 → 红+${WIN_REWARD}，金/银-${LOSE_PENALTY}` };
  }
  if (isMinGold && !isMinRed && !isMinSilver) {
    return { winners: ['gold'], losers: ['red', 'silver'], message: `金苹果（${gold}人）最少 → 金+${WIN_REWARD}，红/银-${LOSE_PENALTY}` };
  }
  if (isMinSilver && !isMinRed && !isMinGold) {
    return { winners: ['silver'], losers: ['red', 'gold'], message: `银苹果（${silver}人）最少 → 银+${WIN_REWARD}，红/金-${LOSE_PENALTY}` };
  }

  // ★ 两色同票且同为最少
  // 有红苹果时：金银是阵营关系，金=银同为最少 → 金银同时胜利
  // 红与另一色同为最少 → 红优先（冒险者胜）
  if (isMinRed && isMinGold && !isMinSilver) {
    // 红和金同为最少，红优先（更冒险）
    return { winners: ['red'], losers: ['gold', 'silver'], message: `红=金（${red}人）同为最少，红苹果冒险优先 → 红+${WIN_REWARD}，金/银-${LOSE_PENALTY}` };
  }
  if (isMinRed && isMinSilver && !isMinGold) {
    // 红和银同为最少，红优先
    return { winners: ['red'], losers: ['gold', 'silver'], message: `红=银（${red}人）同为最少，红苹果冒险优先 → 红+${WIN_REWARD}，金/银-${LOSE_PENALTY}` };
  }
  if (isMinGold && isMinSilver && !isMinRed) {
    // ★ 有红苹果时：金银是阵营，金=银同为最少 → 金银同时胜利
    return { winners: ['gold', 'silver'], losers: ['red'], message: `金=银（${gold}人）同为最少，金银阵营共同胜利 → 金+${WIN_REWARD}，银+${WIN_REWARD}，红-${LOSE_PENALTY}` };
  }

  // fallback（不应到达）
  return { winners: [], losers: ['red', 'gold', 'silver'], message: `判定异常，全员扣除 ${LOSE_PENALTY} 积分` };
}

function calculateResult(votes, round) {
  const isFinalRound = round >= gameState.totalRounds;
  const base = isFinalRound ? calcFinalRound(votes) : calcNormalRound(votes);
  return { ...base, isFinalRound, votes: { ...votes } };
}

// 将结果应用到玩家积分（仅有效玩家参与）
// ★ 以 playerId 为键，杜绝重连换 socket.id 后结果错位
function applyResult(result) {
  const scoreChanges = {};
  const newlyEliminated = [];

  for (const pid in gameState.players) {
    const player = gameState.players[pid];
    let change = 0;

    // 已淘汰玩家不参与
    if (player.eliminated) {
      scoreChanges[pid] = { name: player.name, num: player.num, change: 0, total: player.score, eliminated: true };
      continue;
    }

    if (result.specialEvent === 'all_red') {
      // 全体胜利：不做任何加减（投票是免费的）
      change = 0;
    } else if (!player.voted) {
      // 未投票：扣2000
      player.score -= NO_VOTE_PENALTY;
      change = -NO_VOTE_PENALTY;
    } else {
      const choice = player.voteChoice;
      const betAmt = player.betAmount || 0;  // ★ 加注额
      if (result.winners.includes(choice)) {
        // 赢：基础 +1000 + 加注额
        const totalWin = WIN_REWARD + betAmt;
        player.score += totalWin;
        change = totalWin;
      } else if (result.losers.includes(choice)) {
        // 输：基础 -2000 - 2×加注额，保底0
        const totalPenalty = LOSE_PENALTY + betAmt * 2;
        const actualPenalty = Math.min(totalPenalty, player.score);
        player.score -= actualPenalty;
        change = -actualPenalty;
      }
    }

    // 检查淘汰：积分 <= 0
    if (player.score <= 0 && !player.eliminated) {
      player.eliminated = true;
      player.score = 0;  // 钳位到0
      newlyEliminated.push(pid);
    }

    scoreChanges[pid] = { name: player.name, num: player.num, change, total: player.score, eliminated: player.eliminated };
  }

  return { scoreChanges, newlyEliminated };
}

function getLeaderboard() {
  return Object.values(gameState.players)
    .map(p => ({ id: p.playerId, name: p.name, num: p.num, score: p.score, eliminated: p.eliminated }))
    .sort((a, b) => b.score - a.score);
}

function broadcastPlayerList() {
  io.emit('playerListUpdate', { players: getLeaderboard(), count: Object.keys(gameState.players).length });
}

function broadcastVoteUpdate() {
  const active = getActivePlayers();
  const votedCount = active.filter(p => p.voted).length;
  const payload = { votes: gameState.votes, votedCount, totalCount: active.length };
  io.to('display').emit('voteUpdate', payload);
  io.to('admin').emit('voteUpdate', payload);
}

// ==================== 投票（幂等）====================
function computeMaxBet(score) {
  return Math.max(0, Math.floor(Math.max(0, (score - LOSE_PENALTY) / 2) / 500) * 500);
}

/**
 * 唯一投票入口（HTTP 与 socket 共用）。
 * 幂等保证：同一 (playerId, round) 只计一次票，重复提交返回首次回执。
 */
function castVote({ token, round, choice, betAmount, clientVoteId }) {
  const info = verifyToken(token);
  if (!info) return { ok: false, code: 'BAD_TOKEN', message: '身份已失效，请重新加入' };
  if (info.gameId !== gameId) return { ok: false, code: 'STALE_TOKEN', message: '本局已结束，请重新加入' };

  const player = gameState.players[info.playerId];
  if (!player) return { ok: false, code: 'NO_PLAYER', message: '找不到你的游戏数据，请重新加入' };
  if (!clientVoteId) return { ok: false, code: 'NO_VOTE_ID', message: '缺少投票标识，请重试' };

  const r = Number(round);
  const key = `${info.playerId}:${r}`;

  // ★ 幂等：本轮已记录过 → 原样返回首次回执，不重复计票
  const existing = voteLedger[key];
  if (existing) {
    return { ...existing.ack, duplicate: true };
  }

  if (gameState.status !== 'voting') return { ok: false, code: 'NOT_VOTING', message: '当前不在投票阶段' };
  if (r !== gameState.round) return { ok: false, code: 'WRONG_ROUND', message: '轮次已更新，请刷新页面' };
  if (player.eliminated) return { ok: false, code: 'ELIMINATED', message: '你已被淘汰，无法投票' };
  if (!['gold', 'silver', 'red'].includes(choice)) return { ok: false, code: 'BAD_CHOICE', message: '无效的投票选项' };

  const safeBet = Math.min(Math.max(0, Math.floor((betAmount || 0) / 500) * 500), computeMaxBet(player.score));
  player.voted = true;
  player.voteChoice = choice;
  player.betAmount = safeBet;
  gameState.votes[choice]++;

  const ack = { ok: true, round: r, choice, betAmount: safeBet, score: player.score, clientVoteId, ts: Date.now() };
  voteLedger[key] = { clientVoteId, choice, betAmount: safeBet, ack };
  broadcastVoteUpdate();

  // ★ 全员投票完成 → 立即结算（不用等倒计时结束）
  const active = getActivePlayers();
  const votedCount = active.filter(p => p.voted).length;
  if (active.length > 0 && votedCount >= active.length) {
    console.log(`所有玩家已投票(${votedCount}/${active.length})，立即结算`);
    clearInterval(timerInterval);
    endVoting();
  }

  return ack;
}

// HTTP 投票接口：手机端断网自动补投的可靠通道（socket.io 仅负责实时推送）
app.post('/api/vote', (req, res) => {
  const { token, round, choice, betAmount, clientVoteId } = req.body || {};
  const ack = castVote({ token, round, choice, betAmount, clientVoteId });
  res.json(ack);
});

// ==================== 定时器 ====================
function startTimer() {
  clearInterval(timerInterval);
  gameState.timer = ROUND_TIME;

  timerInterval = setInterval(() => {
    gameState.timer--;
    io.emit('timerUpdate', { timer: gameState.timer });
    if (gameState.timer <= 0) {
      clearInterval(timerInterval);
      endVoting();
    }
  }, 1000);
}

function endVoting() {
  gameState.status = 'result';

  // 投票是免费的，直接计算结果（未投票在applyResult中扣分）
  const result = calculateResult(gameState.votes, gameState.round);
  const { scoreChanges, newlyEliminated } = applyResult(result);
  gameState.roundResult = { ...result, scoreChanges };
  gameState.roundHistory.push({
    round: gameState.round,
    votes: { ...gameState.votes },
    result: result.message,
    specialEvent: result.specialEvent || null,
    isFinalRound: result.isFinalRound,
    eliminatedCount: getActivePlayerCount()
  });

  const activeCount = getActivePlayerCount();

  io.emit('roundEnd', {
    result: gameState.roundResult,
    leaderboard: getLeaderboard(),
    round: gameState.round,
    isFinalRound: result.isFinalRound,
    winCount: gameState.winCount,
    activePlayerCount: activeCount,
    newlyEliminated: newlyEliminated.map(pid => ({
      id: pid, name: gameState.players[pid].name, num: gameState.players[pid].num
    }))
  });

  // ★ 结算结果按 playerId 落库，重连后可补偿拉回
  const myResults = {};
  for (const pid in gameState.players) {
    const player = gameState.players[pid];
    const change = scoreChanges[pid];
    myResults[pid] = {
      voted: player.voted,
      choice: player.voteChoice,
      change: change ? change.change : 0,
      total: player.score,
      eliminated: player.eliminated,
      specialEvent: result.specialEvent || null,
      message: result.message,
      isFinalRound: result.isFinalRound
    };
    const sock = player.socketId ? io.sockets.sockets.get(player.socketId) : null;
    if (sock) sock.emit('myResult', myResults[pid]);
  }
  gameState.lastResults = myResults;

  // 全体胜利 → 自动结束
  if (result.specialEvent === 'all_red') {
    setTimeout(() => triggerGameOver(), 4000);
  }
}

function triggerGameOver() {
  clearInterval(timerInterval);
  gameState.status = 'gameover';
  io.emit('gameOver', { leaderboard: getLeaderboard(), history: gameState.roundHistory, winCount: gameState.winCount });
}

// ==================== Socket.io ====================
io.on('connection', (socket) => {
  console.log('新连接:', socket.id);

  // 新玩家加入（仅 waiting 阶段）
  socket.on('joinGame', ({ name }) => {
    if (gameState.status !== 'waiting') {
      socket.emit('joinError', { message: '游戏已经开始，无法加入。请等待游戏重置。' });
      return;
    }
    const trimName = (name || '').trim().slice(0, 10) || ('玩家' + socket.id.slice(0, 4));
    const playerId = crypto.randomUUID();
    const num = assignPlayerNum();
    gameState.players[playerId] = {
      playerId, name: trimName, num, score: INITIAL_SCORE,
      eliminated: false, voted: false, voteChoice: null, betAmount: 0,
      socketId: socket.id, connected: true, joinedAt: Date.now()
    };
    const token = signToken(playerId, gameId);
    socket.emit('joinSuccess', { playerId, token, name: trimName, num, score: INITIAL_SCORE, reconnected: false });
    broadcastPlayerList();
    console.log(`玩家 ${trimName}(#${num}) 加入，当前人数: ${Object.keys(gameState.players).length}`);
  });

  // ★ 身份识别 / 重连：只认服务端签发的 token，不再按编号猜测
  socket.on('identify', ({ token }) => {
    const info = verifyToken(token);
    if (!info) { socket.emit('identifyFailed', { reason: 'BAD_TOKEN', message: '身份已失效，请重新加入' }); return; }
    if (info.gameId !== gameId) { socket.emit('identifyFailed', { reason: 'STALE_TOKEN', message: '本局已结束，请重新加入' }); return; }

    const player = gameState.players[info.playerId];
    if (!player) { socket.emit('identifyFailed', { reason: 'NO_PLAYER', message: '找不到你的游戏数据，请重新加入' }); return; }

    // 同一身份开新连接 → 踢掉旧连接，避免一台设备多处投票
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) {
        old.emit('kicked', { message: '该身份已在其他设备/页面打开，此连接已断开' });
        old.disconnect(true);
      }
    }
    player.socketId = socket.id;
    player.connected = true;

    socket.emit('joinSuccess', {
      playerId: player.playerId, token, name: player.name, num: player.num,
      score: player.score, eliminated: player.eliminated, reconnected: true
    });

    // 根据当前游戏状态恢复页面
    if (gameState.status === 'voting') {
      const isFinalRound = gameState.round >= gameState.totalRounds;
      socket.emit('gameStart', {
        round: gameState.round, timer: gameState.timer, totalRounds: gameState.totalRounds,
        winCount: gameState.winCount, isFinalRound, activePlayerCount: getActivePlayerCount()
      });
      const rec = voteLedger[`${player.playerId}:${gameState.round}`];
      if (rec) socket.emit('voteSuccess', { choice: rec.choice, score: player.score, betAmount: rec.betAmount });
    } else if (gameState.status === 'result' && gameState.lastResults[player.playerId]) {
      socket.emit('myResult', gameState.lastResults[player.playerId]);
    } else if (gameState.status === 'gameover') {
      socket.emit('gameOver', { leaderboard: getLeaderboard(), history: gameState.roundHistory, winCount: gameState.winCount });
    }

    broadcastPlayerList();
    console.log(`玩家 ${player.name}(#${player.num}) 通过 token 恢复`);
  });

  // 兼容：旧版/测试页仍可用 socket 投票（走同一个幂等入口）
  socket.on('vote', ({ choice, betAmount, clientVoteId, round }) => {
    const player = getPlayerBySocket(socket.id);
    if (!player) { socket.emit('voteError', { message: '你还没有加入游戏' }); return; }
    const ack = castVote({
      token: signToken(player.playerId, gameId),
      round: round || gameState.round,
      choice, betAmount, clientVoteId: clientVoteId || `socket:${socket.id}:${gameState.round}`
    });
    if (ack.ok) socket.emit('voteSuccess', { choice: ack.choice, score: ack.score, betAmount: ack.betAmount });
    else socket.emit('voteError', { message: ack.message });
  });

  // 管理员：开始游戏
  socket.on('adminStartGame', () => {
    if (gameState.status !== 'waiting') return;
    if (Object.keys(gameState.players).length === 0) {
      socket.emit('adminError', { message: '还没有玩家加入' }); return;
    }
    gameState.status = 'voting';
    gameState.round = 1;
    gameState.votes = { red: 0, gold: 0, silver: 0 };
    gameState.lastResults = {};
    voteLedger = {};
    for (const pid in gameState.players) {
      const p = gameState.players[pid];
      if (!p.eliminated) {
        p.voted = false;
        p.voteChoice = null;
        p.betAmount = 0;
      }
    }
    const isFinalRound = gameState.round >= gameState.totalRounds;
    const activeCount = getActivePlayerCount();
    io.emit('gameStart', { round: gameState.round, timer: ROUND_TIME, totalRounds: gameState.totalRounds, winCount: gameState.winCount, isFinalRound, activePlayerCount: activeCount });
    startTimer();
    console.log('游戏开始，第1轮');
  });

  // 管理员：下一轮
  socket.on('adminNextRound', () => {
    if (gameState.status !== 'result') return;

    // 检查是否还有有效玩家
    if (getActivePlayerCount() === 0) {
      triggerGameOver();
      return;
    }

    gameState.round++;
    gameState.status = 'voting';
    gameState.votes = { red: 0, gold: 0, silver: 0 };
    gameState.roundResult = null;
    gameState.lastResults = {};
    for (const pid in gameState.players) {
      const p = gameState.players[pid];
      if (!p.eliminated) {
        p.voted = false;
        p.voteChoice = null;
        p.betAmount = 0;
      }
    }
    const isFinalRound = gameState.round >= gameState.totalRounds;
    const activeCount = getActivePlayerCount();
    io.emit('nextRound', { round: gameState.round, timer: ROUND_TIME, totalRounds: gameState.totalRounds, winCount: gameState.winCount, isFinalRound, activePlayerCount: activeCount });
    startTimer();
    console.log(`开始第${gameState.round}轮${isFinalRound ? '（最终轮）' : ''}，有效玩家: ${activeCount}`);
  });

  socket.on('adminEndGame', () => { triggerGameOver(); });

  socket.on('adminResetGame', () => {
    clearInterval(timerInterval);
    nextPlayerNum = 1;  // 重置编号
    gameId = crypto.randomBytes(8).toString('hex');  // ★ 旧 token 全部作废，杜绝跨局串号
    voteLedger = {};
    gameState = {
      status: 'waiting', round: 0, totalRounds: gameState.totalRounds, winCount: gameState.winCount,
      players: {}, votes: { red: 0, gold: 0, silver: 0 },
      timer: ROUND_TIME, roundResult: null, roundHistory: [], lastResults: {}, publicUrl: gameState.publicUrl
    };
    io.emit('gameReset');
    console.log('游戏已重置（gameId 已更新）');
  });

  socket.on('adminForceEnd', () => {
    if (gameState.status !== 'voting') return;
    clearInterval(timerInterval);
    endVoting();
  });

  // 设置总轮数
  socket.on('adminSetRounds', ({ rounds }) => {
    if (gameState.status !== 'waiting') return;
    const r = parseInt(rounds);
    if (r >= 1 && r <= 20) {
      gameState.totalRounds = r;
      io.to('admin').emit('settingsUpdate', { totalRounds: gameState.totalRounds, winCount: gameState.winCount });
    }
  });

  // ★ 设置前N名获胜
  socket.on('adminSetWinCount', ({ winCount }) => {
    if (gameState.status !== 'waiting') return;
    const w = parseInt(winCount);
    if (w >= 1 && w <= 50) {
      gameState.winCount = w;
      io.to('admin').emit('settingsUpdate', { totalRounds: gameState.totalRounds, winCount: gameState.winCount });
    }
  });

  socket.on('joinDisplay', () => {
    socket.join('display');
    socket.emit('gameStateSync', {
      status: gameState.status, round: gameState.round, timer: gameState.timer,
      votes: gameState.votes, leaderboard: getLeaderboard(),
      roundHistory: gameState.roundHistory,
      playerCount: Object.keys(gameState.players).length,
      activePlayerCount: getActivePlayerCount(),
      totalRounds: gameState.totalRounds,
      winCount: gameState.winCount,
      isFinalRound: gameState.round >= gameState.totalRounds
    });
  });

  socket.on('joinAdmin', () => {
    socket.join('admin');
    socket.emit('gameStateSync', {
      status: gameState.status, round: gameState.round, timer: gameState.timer,
      votes: gameState.votes, leaderboard: getLeaderboard(),
      roundHistory: gameState.roundHistory,
      playerCount: Object.keys(gameState.players).length,
      activePlayerCount: getActivePlayerCount(),
      totalRounds: gameState.totalRounds,
      winCount: gameState.winCount,
      isFinalRound: gameState.round >= gameState.totalRounds
    });
  });

  socket.on('disconnect', () => {
    const player = getPlayerBySocket(socket.id);
    if (player) {
      player.connected = false;
      console.log(`玩家 ${player.name}(#${player.num}) 断线（保留数据，可用 token 重连）`);
    }
  });
});

// ==================== 二维码接口（支持Render） ====================
app.get('/qrcode', async (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const url = `${protocol}://${host}/player/`;
  try {
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qr, url });
  } catch (e) {
    res.json({ qr: '', url });
  }
});

app.get('/serverinfo', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const base = `${protocol}://${host}`;
  const localIP = getLocalIP();
  res.json({ base, ip: localIP, port: PORT });
});

// ==================== 启动 ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('\n🌿 ========== 伊甸园游戏服务器已启动 ==========');
  console.log(`📺 大屏展示端: http://${localIP}:${PORT}/display/`);
  console.log(`🎮 后台控制端: http://${localIP}:${PORT}/admin/`);
  console.log(`📱 玩家扫码端: http://${localIP}:${PORT}/player/`);
  console.log('=============================================\n');
});
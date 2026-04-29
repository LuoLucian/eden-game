const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
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
  players: {},         // { socketId: { name, num, score, eliminated, voted, voteChoice } }
  votes: { red: 0, gold: 0, silver: 0 },
  timer: ROUND_TIME,
  roundResult: null,
  roundHistory: [],
  publicUrl: ''
};

let timerInterval = null;

// ==================== 有效玩家（未淘汰）====================
function getActivePlayers() {
  return Object.entries(gameState.players)
    .filter(([_, p]) => !p.eliminated)
    .map(([id, p]) => ({ id, ...p }));
}

function getActivePlayerCount() {
  return Object.values(gameState.players).filter(p => !p.eliminated).length;
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
function applyResult(result) {
  const scoreChanges = {};
  const newlyEliminated = [];

  for (const id in gameState.players) {
    const player = gameState.players[id];
    let change = 0;

    // 已淘汰玩家不参与
    if (player.eliminated) {
      scoreChanges[id] = { name: player.name, num: player.num, change: 0, total: player.score, eliminated: true };
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
      newlyEliminated.push(id);
    }

    scoreChanges[id] = { name: player.name, num: player.num, change, total: player.score, eliminated: player.eliminated };
  }

  return { scoreChanges, newlyEliminated };
}

function getLeaderboard() {
  return Object.entries(gameState.players)
    .map(([id, p]) => ({ id, name: p.name, num: p.num, score: p.score, eliminated: p.eliminated }))
    .sort((a, b) => b.score - a.score);
}

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
    newlyEliminated: newlyEliminated.map(id => ({
      id, name: gameState.players[id].name, num: gameState.players[id].num
    }))
  });

  // 通知每个玩家个人结果
  for (const id in gameState.players) {
    const player = gameState.players[id];
    const change = scoreChanges[id];
    const sock = io.sockets.sockets.get(id);
    if (sock) {
      sock.emit('myResult', {
        voted: player.voted,
        choice: player.voteChoice,
        change: change ? change.change : 0,
        total: player.score,
        eliminated: player.eliminated,
        specialEvent: result.specialEvent || null,
        message: result.message,
        isFinalRound: result.isFinalRound
      });
    }
  }

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

  socket.on('joinGame', ({ name }) => {
    // 游戏进行中禁止加入（仅waiting状态可以）
    if (gameState.status !== 'waiting') {
      socket.emit('joinError', { message: '游戏已经开始，无法加入。请等待游戏重置。' });
      return;
    }
    const trimName = (name || '').trim().slice(0, 10) || ('玩家' + socket.id.slice(0, 4));
    const num = assignPlayerNum();
    gameState.players[socket.id] = { name: trimName, num, score: INITIAL_SCORE, eliminated: false, voted: false, voteChoice: null, betAmount: 0 };
    socket.emit('joinSuccess', { name: trimName, num, score: INITIAL_SCORE, playerId: socket.id });
    io.emit('playerListUpdate', { players: getLeaderboard(), count: Object.keys(gameState.players).length });
    console.log(`玩家 ${trimName}(#${num}) 加入，当前人数: ${Object.keys(gameState.players).length}`);
  });

  // ★ 玩家重连恢复（锁屏后重连）
  socket.on('reconnectPlayer', ({ playerId, num }) => {
    // 查找旧玩家数据（用编号匹配）
    let oldPlayer = null;
    let oldId = null;
    for (const id in gameState.players) {
      if (gameState.players[id].num === num) {
        oldPlayer = gameState.players[id];
        oldId = id;
        break;
      }
    }
    if (!oldPlayer) {
      socket.emit('joinError', { message: '找不到你的游戏数据，请重新加入' });
      return;
    }

    // 把旧数据迁移到新 socket.id
    gameState.players[socket.id] = { ...oldPlayer };
    delete gameState.players[oldId];

    // 发送恢复成功事件 + 当前游戏状态
    socket.emit('joinSuccess', { name: gameState.players[socket.id].name, num: gameState.players[socket.id].num, score: gameState.players[socket.id].score, playerId: socket.id });

    // 根据当前游戏状态恢复页面
    if (gameState.status === 'voting') {
      const isFinalRound = gameState.round >= gameState.totalRounds;
      socket.emit('gameStart', { round: gameState.round, timer: gameState.timer, totalRounds: gameState.totalRounds, isFinalRound, activePlayerCount: getActivePlayerCount() });
      // 如果已投票，补发投票确认
      if (gameState.players[socket.id].voted) {
        socket.emit('voteSuccess', { choice: gameState.players[socket.id].voteChoice, score: gameState.players[socket.id].score });
      }
    } else if (gameState.status === 'result' && gameState.roundResult) {
      // 结算阶段 — 发送结果
      const result = gameState.roundResult;
      const change = result.scoreChanges[socket.id];
      if (change) {
        socket.emit('myResult', {
          voted: gameState.players[socket.id].voted,
          choice: gameState.players[socket.id].voteChoice,
          change: change.change,
          total: gameState.players[socket.id].score,
          eliminated: gameState.players[socket.id].eliminated,
          specialEvent: result.specialEvent || null,
          message: result.message,
          isFinalRound: result.isFinalRound
        });
      }
    }

    console.log(`玩家 ${gameState.players[socket.id].name}(#${num}) 重连恢复`);
  });

  socket.on('vote', ({ choice, betAmount }) => {
    const player = gameState.players[socket.id];
    if (!player) { socket.emit('voteError', { message: '你还没有加入游戏' }); return; }
    if (gameState.status !== 'voting') { socket.emit('voteError', { message: '当前不在投票阶段' }); return; }
    if (player.eliminated) { socket.emit('voteError', { message: '你已被淘汰，无法投票' }); return; }
    if (player.voted) { socket.emit('voteError', { message: '你已经投过票了' }); return; }
    if (!['gold', 'silver', 'red'].includes(choice)) { socket.emit('voteError', { message: '无效的投票选项' }); return; }

    // 投票免费，不扣积分
    player.voted = true;
    player.voteChoice = choice;
    player.betAmount = Math.max(0, Math.min(betAmount || 0, Math.floor(Math.max(0, (player.score - LOSE_PENALTY) / 2) / 500) * 500));  // ★ 存储加注额（带安全校验）
    gameState.votes[choice]++;

    socket.emit('voteSuccess', { choice, score: player.score });

    // 只统计有效玩家的投票数
    const activePlayers = Object.values(gameState.players).filter(p => !p.eliminated);
    const votedCount = activePlayers.filter(p => p.voted).length;
    const totalCount = activePlayers.length;
    io.to('display').emit('voteUpdate', { votes: gameState.votes, votedCount, totalCount });
    io.to('admin').emit('voteUpdate', { votes: gameState.votes, votedCount, totalCount });

    // ★ 全员投票完成 → 立即结算（不用等倒计时结束）
    if (votedCount >= totalCount && totalCount > 0) {
      console.log(`所有玩家已投票(${votedCount}/${totalCount})，立即结算`);
      clearInterval(timerInterval);
      endVoting();
    }
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
    for (const id in gameState.players) {
      const p = gameState.players[id];
      if (!p.eliminated) {
        p.voted = false;
        p.voteChoice = null;
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
    for (const id in gameState.players) {
      const p = gameState.players[id];
      if (!p.eliminated) {
        p.voted = false;
        p.voteChoice = null;
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
    gameState = {
      status: 'waiting', round: 0, totalRounds: gameState.totalRounds, winCount: gameState.winCount,
      players: {}, votes: { red: 0, gold: 0, silver: 0 },
      timer: ROUND_TIME, roundResult: null, roundHistory: [], publicUrl: gameState.publicUrl
    };
    io.emit('gameReset');
    console.log('游戏已重置');
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
    if (gameState.players[socket.id]) {
      console.log(`玩家 ${gameState.players[socket.id].name}(#${gameState.players[socket.id].num}) 断线（保留数据）`);
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

from flask import Flask, render_template, request, jsonify, make_response
import os
import json
import threading
import time
import copy
import secrets
from threading import Lock

app = Flask(__name__)
app.secret_key = 'eden_game_secret_key_2026'

# 全局锁：确保 /join 请求串行执行
join_lock = Lock()

# 配置
START_BALANCE = 10000
MAX_PLAYERS = 70
MAX_ROUNDS = 8
VOTING_DURATION = 60
REWARD = 1000    # 奖励
PENALTY = 2000   # 惩罚（原为1000）

game_state = {
    'current_round': 1,
    'round_status': 'waiting',  # 'waiting', 'voting', 'ended'
    'game_ended': False,
    'voting_start_time': None
}
players = {}
DATA_FILE = 'game_data.json'
SNAPSHOT_FILE = 'snapshots.json'
snapshots = {}

def load_data():
    global game_state, players
    # 默认状态
    default_game_state = {
        'current_round': 1,
        'round_status': 'waiting',
        'game_ended': False,
        'voting_start_time': None,
        'won_by_all': False  # 新增字段，用于标记全体胜利
    }
    
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                raw_data = json.load(f)
            
            # 安全提取 game_state
            loaded_game_state = raw_data.get('game_state', {})
            loaded_players = raw_data.get('players', {})

            # 合并默认值 + 加载值
            merged_game_state = {**default_game_state, **loaded_game_state}

            # ✅ 关键：清洗 voting_start_time
            vst = merged_game_state.get('voting_start_time')
            if vst is not None:
                try:
                    merged_game_state['voting_start_time'] = float(vst)
                except (ValueError, TypeError):
                    merged_game_state['voting_start_time'] = None

            # ✅ 清洗 players 数据（防止 ID 不是 int）
            cleaned_players = {}
            for k, v in loaded_players.items():
                try:
                    pid = int(k)
                    # 确保玩家结构完整
                    cleaned_players[pid] = {
                        'id': pid,
                        'balance': int(v.get('balance', START_BALANCE)),
                        'votes': list(v.get('votes', []))
                    }
                except (ValueError, TypeError, AttributeError):
                    continue  # 跳过损坏的玩家数据

            game_state.update(merged_game_state)
            players.clear()
            players.update(cleaned_players)

        except Exception as e:
            print(f"⚠️ 警告：加载 {DATA_FILE} 失败，使用默认状态。错误：{e}")
            game_state.update(default_game_state)
            players.clear()
            save_data()  # 重建干净文件
    else:
        # 文件不存在，初始化
        game_state.update(default_game_state)
        players.clear()

def save_data():
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump({
            'game_state': game_state,
            'players': players
        }, f, ensure_ascii=False, indent=2)

def load_snapshots():
    global snapshots
    if os.path.exists(SNAPSHOT_FILE):
        with open(SNAPSHOT_FILE, 'r', encoding='utf-8') as f:
            snapshots = json.load(f)

def save_snapshot(round_num):
    snapshots[str(round_num)] = {
        'players': copy.deepcopy(players),
        'game_state': copy.deepcopy(game_state)
    }
    with open(SNAPSHOT_FILE, 'w', encoding='utf-8') as f:
        json.dump(snapshots, f, ensure_ascii=False, indent=2)

load_data()
load_snapshots()

def auto_end_voting():
    while True:
        time.sleep(5)
        with app.app_context():
            if (game_state['round_status'] == 'voting' and game_state['voting_start_time'] is not None):
                elapsed = time.time() - game_state['voting_start_time']
                if elapsed >= VOTING_DURATION:
                    try:
                        end_round_logic()
                        save_data()
                    except Exception as e:
                        print("💥 结算崩溃！错误：", repr(e))
                        import traceback
                        traceback.print_exc()
                        # 防止线程退出
                        game_state['round_status'] = 'waiting'
                        game_state['voting_start_time'] = None
threading.Thread(target=auto_end_voting, daemon=True).start()

def end_round_logic():
    current_round = game_state['current_round']
    
    # Step 1: 扣除未投票玩家 PENALTY（-2000）
    for pid, p in players.items():
        if len(p['votes']) < current_round:
            p['balance'] = max(0, p['balance'] - PENALTY)

    # Step 2: 收集本轮已投票玩家（用于计票）
    voted_players = [p for p in players.values() if len(p['votes']) >= current_round]
    total_voted = len(voted_players)
    
    # 初始化计票
    votes = {'red': 0, 'gold': 0, 'silver': 0}
    for p in voted_players:
        apple = p['votes'][current_round - 1]
        if apple in votes:
            votes[apple] += 1
    
    red, gold, silver = votes['red'], votes['gold'], votes['silver']
    game_won_by_all = False

    # ====== 全体胜利条件（兼容旧规则 + 新增规则）======
    game_won_by_all = False
    if total_voted > 0:
        # 原有规则：仅1人投票且投红 → 全体胜利
        if total_voted == 1 and red == 1:
            game_won_by_all = True
        # 新增规则1：前7轮所有人投红
        elif current_round < MAX_ROUNDS and red == total_voted:
            game_won_by_all = True
        # 新增规则2：第8轮红 >= 总投票 - 10
        elif current_round == MAX_ROUNDS and red >= total_voted - 10:
            game_won_by_all = True

    if game_won_by_all:
        # ✅ 全体胜利：余额保持不变（不加奖励，不扣惩罚）
        game_state['game_ended'] = True
        game_state['round_status'] = 'ended'
        game_state['won_by_all'] = True
        save_snapshot(current_round)
        return

    # ====== 常规结算逻辑（与原逻辑一致，仅惩罚值改为 PENALTY）======
    if total_voted == 0:
        # 无人投票：已在 Step 1 扣款，无需额外操作
        pass

    elif total_voted == 1:
        # 此时 red != 1（否则已触发全体胜利），所以是金或银
        for p in players.values():
            p['balance'] = max(0, p['balance'] - PENALTY)

    else:
        # 多人投票
        if red == 0:
            if gold < silver:
                for p in voted_players:
                    if p['votes'][current_round - 1] == 'gold':
                        p['balance'] += REWARD
                    else:
                        p['balance'] = max(0, p['balance'] - PENALTY)
            elif silver < gold:
                for p in voted_players:
                    if p['votes'][current_round - 1] == 'silver':
                        p['balance'] += REWARD
                    else:
                        p['balance'] = max(0, p['balance'] - PENALTY)
            else:
                # 金 == 银（含全金、全银）
                for p in players.values():
                    p['balance'] = max(0, p['balance'] - PENALTY)
        else:
                # 有人投红（red > 0）
                if current_round == MAX_ROUNDS:
                    # ===== 第8轮特殊规则（最终版）=====
                    if red == gold == silver:
                        # 三者完全相等 → 全员惩罚
                        for p in players.values():
                            if len(p['votes']) >= current_round:
                                p['balance'] = max(0, p['balance'] - PENALTY)
                    elif gold == silver:
                        # 金 == 银，但红 ≠ 金 → 红胜
                        for p in players.values():
                            if len(p['votes']) >= current_round:
                                vote = p['votes'][current_round - 1]
                                if vote == 'red':
                                    p['balance'] += REWARD
                                else:
                                    p['balance'] = max(0, p['balance'] - PENALTY)
                    elif red < gold and red < silver:
                        # 金 ≠ 银，且红严格最少 → 红胜
                        for p in players.values():
                            if len(p['votes']) >= current_round:
                                vote = p['votes'][current_round - 1]
                                if vote == 'red':
                                    p['balance'] += REWARD
                                else:
                                    p['balance'] = max(0, p['balance'] - PENALTY)
                    else:
                        # 金 ≠ 银，且红非严格最少 → 较少的非红颜色胜出
                        if gold < silver:
                            winner = 'gold'
                        else:
                            winner = 'silver'
                        for p in players.values():
                            if len(p['votes']) >= current_round:
                                vote = p['votes'][current_round - 1]
                                if vote == winner:
                                    p['balance'] += REWARD
                                else:
                                    p['balance'] = max(0, p['balance'] - PENALTY)
                else:
                    # ===== 非第8轮：原逻辑 =====
                    for p in voted_players:
                        if p['votes'][current_round - 1] == 'red':
                            p['balance'] = max(0, p['balance'] - PENALTY)
                        else:
                            p['balance'] += REWARD

    # ===== 游戏结束判断 =====
    if current_round >= MAX_ROUNDS:
        game_state['game_ended'] = True
        game_state['round_status'] = 'ended'
    else:
        game_state['current_round'] += 1
        game_state['round_status'] = 'waiting'
        game_state['voting_start_time'] = None

    # 保存快照
    save_snapshot(current_round)

# ===== 核心修复：扫码加入（支持老玩家随时返回）=====
@app.route('/join')
def join():
    with join_lock:
        existing_id = request.cookies.get('eden_player_id')
        if existing_id and existing_id.isdigit():
            pid = int(existing_id)
            if pid in players:
                if not game_state['game_ended']:
                    return f'<script>window.location.href="/mobile?playerId={pid}";</script>'
                else:
                    return "🏁 游戏已结束！", 403

        if game_state['game_ended']:
            return "❌ 游戏已结束", 403
        if game_state['round_status'] != 'waiting':
            return "❌ 游戏已开始，无法加入新玩家", 403
        if len(players) >= MAX_PLAYERS:
            return "❌ 玩家人数已达上限", 403

        used_ids = set(players.keys())
        available_ids = [i for i in range(1, MAX_PLAYERS + 1) if i not in used_ids]
        if not available_ids:
            return "❌ 无可用ID", 500

        pid = secrets.choice(available_ids)
        players[pid] = {
            'id': pid,
            'balance': START_BALANCE,
            'votes': []
        }
        save_data()

        resp = make_response(f'<script>window.location.href="/mobile?playerId={pid}";</script>')
        resp.set_cookie('eden_player_id', str(pid), max_age=86400)
        return resp

# ===== 其他路由（完全保留）=====
@app.route('/')
def index():
    return "伊甸园游戏系统"

@app.route('/mobile')
def mobile():
    player_id = request.args.get('playerId', type=int)
    if player_id is None or player_id <= 0:
        return "❌ 请提供有效的 playerId，例如：/mobile?playerId=1", 400

    if player_id not in players and game_state['round_status'] != 'waiting':
        return "❌ 游戏已开始，无法加入新玩家", 403

    if player_id not in players:
        if len(players) >= MAX_PLAYERS:
            return "❌ 玩家人数已达上限", 403
        players[player_id] = {
            'id': player_id,
            'balance': START_BALANCE,
            'votes': []
        }
        save_data()

    player = players[player_id]
    current_round = game_state['current_round']
    voted = len(player['votes']) >= current_round
    return render_template('mobile.html',
                           playerId=player_id,
                           balance=player['balance'],
                           voted=voted,
                           current_round=current_round,
                           game_ended=game_state['game_ended'],
                           round_status=game_state['round_status'])

@app.route('/display')
def display():
    top20 = sorted(players.values(), key=lambda x: x['balance'], reverse=True)[:20]
    round_results = None
    
     # ✅ 如果因全体胜利结束，直接显示
    if game_state.get('won_by_all', False):
        # 收集最后一轮的投票数据（用于显示苹果数量）
        current_round = game_state['current_round']
        votes = {'red': 0, 'gold': 0, 'silver': 0}
        for p in players.values():
            if len(p['votes']) >= current_round:
                apple = p['votes'][current_round - 1]
                if apple in votes:
                    votes[apple] += 1
        
        round_results = {
            'votes': votes,
            'message': "🎉 全体胜利！"
        }
    elif game_state['current_round'] > 1 and (game_state['round_status'] == 'waiting' or game_state['game_ended']):
        prev_round = game_state['current_round'] - 1
        votes = {'red': 0, 'gold': 0, 'silver': 0}
        for p in players.values():
            if len(p['votes']) >= prev_round:
                apple = p['votes'][prev_round - 1]
                if apple in votes:
                    votes[apple] += 1
        
        red, gold, silver = votes['red'], votes['gold'], votes['silver']
        total = red + gold + silver
        
        if total == 0:
            msg = "无人投票"
        elif red == total:
            msg = "全体胜利！"
        elif total == 1:
            if red == 1:
                msg = "唯一玩家投红：全体胜利！"
            else:
                msg = f"唯一玩家投金/银：全员-{PENALTY}"
        elif red == 0:
            if gold < silver:
                msg = f"金少胜出：金+{REWARD}，银-{PENALTY}"
            elif silver < gold:
                msg = f"银少胜出：银+{REWARD}，金-{PENALTY}"
            else:
                msg = f"金银相等：全员-{PENALTY}"
        else:
            if red < gold and red < silver:
                msg = f"红苹果最少：红+{REWARD}，金银-{PENALTY}"
            else:
                msg = f"红苹果非最少：红-{PENALTY}，金银+{REWARD}"
        
        round_results = {
            'votes': votes,
            'message': msg
        }

    # ===== 新增：服务端倒计时（用于 display.html 直接渲染）=====
    countdown = None
    in_voting = (game_state['round_status'] == 'voting')
    if in_voting and game_state.get('voting_start_time') is not None:
        remaining = int(game_state['voting_start_time'] + VOTING_DURATION - time.time())
        countdown = max(0, remaining) 

    return render_template('display.html',
                           current_round=game_state['current_round'],
                           round_status=game_state['round_status'],
                           game_ended=game_state['game_ended'],
                           won_by_all=game_state.get('won_by_all', False), 
                           top15=top20,
                           round_results=round_results,
                           countdown=countdown,      
                           in_voting=in_voting)      

@app.route('/admin')
def admin():
    total_players = len(players)
    not_voted_count = 0
    if game_state['round_status'] == 'voting':
        current_round = game_state['current_round']
        not_voted_count = sum(1 for p in players.values() if len(p['votes']) < current_round)
    top15 = sorted(players.values(), key=lambda x: x['balance'], reverse=True)[:15]
    remaining_time = None
    if game_state['round_status'] == 'voting' and game_state['voting_start_time']:
        elapsed = time.time() - game_state['voting_start_time']
        remaining_time = max(0, VOTING_DURATION - int(elapsed))
    return render_template('admin.html',
                           current_round=game_state['current_round'],
                           round_status=game_state['round_status'],
                           game_ended=game_state['game_ended'],
                           total_players=len(players),
                           max_players=MAX_PLAYERS,
                           not_voted_count=not_voted_count,
                           remaining_time=remaining_time,
                           top15=top15)

@app.route('/admin/status_json')
def admin_status_json():
    remaining_time = None
    if game_state['round_status'] == 'voting' and game_state['voting_start_time']:
        elapsed = time.time() - game_state['voting_start_time']
        remaining_time = max(0, VOTING_DURATION - int(elapsed))
    
    current_round = game_state['current_round']
    
    # ✅ 关键修复：只统计 balance > 0 的玩家
    eligible_players = [p for p in players.values() if p['balance'] > 0]
    total_players = len(eligible_players)
    not_voted_count = sum(1 for p in eligible_players if len(p['votes']) < current_round)

    return jsonify({
        'current_round': game_state['current_round'],
        'round_status': game_state['round_status'],
        'game_ended': game_state['game_ended'],
        'total_players': total_players,
        'not_voted_count': not_voted_count,
        'remaining_time': remaining_time
    })

@app.route('/admin/start_round', methods=['POST'])
def start_round():
    if game_state['game_ended']:
        return jsonify({'success': False, 'message': '游戏已结束'})
    if game_state['round_status'] != 'waiting':
        return jsonify({'success': False, 'message': '当前不在等待状态'})
    game_state['round_status'] = 'voting'
    game_state['voting_start_time'] = time.time()
    save_data()
    return jsonify({'success': True})

@app.route('/admin/end_round', methods=['POST'])
def end_round():
    if game_state['round_status'] != 'voting':
        return jsonify({'success': False, 'message': '当前不在投票中'})
    end_round_logic()
    save_data()
    return jsonify({'success': True})

@app.route('/admin/reset_current_round', methods=['POST'])
def reset_current_round():
    if game_state['game_ended']:
        return jsonify({'success': False, 'message': '游戏已结束，无法重置本轮'})
    current_round = game_state['current_round']
    for p in players.values():
        if len(p['votes']) >= current_round:
            p['votes'] = p['votes'][:current_round - 1]
    game_state['round_status'] = 'waiting'
    game_state['voting_start_time'] = None
    save_data()
    return jsonify({'success': True, 'message': f'第 {current_round} 轮已重置'})

@app.route('/admin/rollback_to_previous', methods=['POST'])
def rollback_to_previous():
    current_round = game_state['current_round']
    if current_round <= 1:
        return jsonify({'success': False, 'message': '已是第1轮，无法回退'})
    prev_round = current_round - 1
    if str(prev_round) not in snapshots:
        return jsonify({'success': False, 'message': f'未找到第 {prev_round} 轮的快照'})
    snap = snapshots[str(prev_round)]
    players.clear()
    players.update(snap['players'])
    game_state.update(snap['game_state'])
    save_data()
    return jsonify({'success': True, 'message': f'已回退到第 {prev_round} 轮结束时的状态'})

@app.route('/admin/reset_all', methods=['POST'])
def reset_all():
    global players, game_state, snapshots
    players.clear()
    game_state = {
        'current_round': 1,
        'round_status': 'waiting',
        'game_ended': False,
        'voting_start_time': None,
        'won_by_all': False
    }
    snapshots.clear()
    if os.path.exists(DATA_FILE):
        os.remove(DATA_FILE)
    if os.path.exists(SNAPSHOT_FILE):
        os.remove(SNAPSHOT_FILE)
    return jsonify({'success': True, 'message': '所有数据已重置！'})

@app.route('/api/vote', methods=['POST'])
def vote():
    data = request.get_json()
    player_id = data.get('playerId')
    apple = data.get('apple')
    if player_id not in players:
        return jsonify({'success': False, 'message': '玩家不存在'})
    if apple not in ['red', 'gold', 'silver']:
        return jsonify({'success': False, 'message': '无效选择'})
    if game_state['round_status'] != 'voting':
        return jsonify({'success': False, 'message': '不在投票阶段'})
    if game_state['game_ended']:
        return jsonify({'success': False, 'message': '游戏已结束'})
    player = players[player_id]
    current_round = game_state['current_round']

    # ✅ 新增：余额 <= 0 不能投票
    if player['balance'] <= 0:
        return jsonify({'success': False, 'message': '你的余额已耗尽，无法继续投票'})

    if len(player['votes']) >= current_round:
        return jsonify({'success': False, 'message': '你已投票'})
    player['votes'].append(apple)
    save_data()

      # === 修复：仅当所有【余额 > 0】的玩家都已投票时，才提前结算 ===
    current_round = game_state['current_round']
    eligible_players = [p for p in players.values() if p['balance'] > 0]
    voted_eligible = [p for p in eligible_players if len(p['votes']) >= current_round]

    if len(eligible_players) > 0 and len(voted_eligible) == len(eligible_players):
        print(f">>> 所有 {len(eligible_players)} 名可投票玩家已提交，提前结算！")
        try:
            end_round_logic()
            save_data()
        except Exception as e:
            print("💥 提前结算失败：", repr(e))
            import traceback
            traceback.print_exc()

    return jsonify({'success': True})

# ✅ 修复版 /api/timer（类型安全）
@app.route('/api/timer')
def get_timer():
    if game_state['round_status'] != 'voting':
        return jsonify({'inVoting': False})
    
    start_time = game_state.get('voting_start_time')
    if start_time is None:
        return jsonify({'inVoting': False})
    
    # ✅ 确保是数字类型
    if not isinstance(start_time, (int, float)):
        start_time = time.time()
        game_state['voting_start_time'] = start_time
        save_data()
    
    elapsed = time.time() - start_time
    remaining = max(0, VOTING_DURATION - int(elapsed))
    return jsonify({
        'inVoting': True,
        'remaining': remaining
    })


@app.route('/api/vote-status')
def vote_status():
    if game_state['round_status'] != 'voting':
        return jsonify({
            'in_voting': False,
            'total_players': 0,
            'voted_players': 0
        })

    current_round = game_state['current_round']
    # ✅ 仅统计 balance > 0 的玩家
    eligible_players = [p for p in players.values() if p['balance'] > 0]
    voted_eligible = sum(1 for p in eligible_players if len(p['votes']) >= current_round)

    return jsonify({
        'in_voting': True,
        'total_players': len(eligible_players),
        'voted_players': voted_eligible
    })

@app.route('/api/player-status/<int:player_id>')
def player_status(player_id):
    if player_id not in players:
        return jsonify({'error': 'Player not found'}), 404
    return jsonify({
        'current_round': game_state['current_round'],
        'game_ended': game_state['game_ended']
    })

@app.route('/mobile/check_status')
def mobile_check_status():
    player_id = request.args.get('playerId', type=int)
    if player_id not in players:
        return jsonify({'success': False, 'message': '玩家不存在'}), 404
    return jsonify({
        'success': True,
        'current_round': game_state['current_round'],
        'game_ended': game_state['game_ended']
    })

@app.route('/rules')
def rules():
    return render_template('rules.html')

# ===== 启动配置 =====
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
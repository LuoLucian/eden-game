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
        'voting_start_time': None
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
    
    # Step 1: 扣除未投票玩家 1000（包括未加入者）
    for pid, p in players.items():
        if len(p['votes']) < current_round:
            p['balance'] = max(0, p['balance'] - 1000)

    # Step 2: 收集本轮有效投票者
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

    # ====== 按新规则处理 ======
    if total_voted == 0:
        # 无人投票：不奖不罚
        pass

    elif total_voted == 1:
        # ✅ 只有1人投票
        if red == 1:
            game_won_by_all = True
        else:
            # 投金或银 → 全体 -1000
            for p in players.values():
                p['balance'] = max(0, p['balance'] - 1000)

    else:
        # 多人投票
        if red == total_voted:
            game_won_by_all = True
        elif red == 0:
            if gold < silver:
                for p in voted_players:
                    if p['votes'][current_round - 1] == 'gold':
                        p['balance'] += 1000
                    else:
                        p['balance'] = max(0, p['balance'] - 1000)
            elif silver < gold:
                for p in voted_players:
                    if p['votes'][current_round - 1] == 'silver':
                        p['balance'] += 1000
                    else:
                        p['balance'] = max(0, p['balance'] - 1000)
            else:
                # 金 == 银 → 全体 -1000
                for p in players.values():
                    p['balance'] = max(0, p['balance'] - 1000)
        else:
            if red < gold and red < silver:
                for p in voted_players:
                    if p['votes'][current_round - 1] == 'red':
                        p['balance'] += 1000
                    else:
                        p['balance'] = max(0, p['balance'] - 1000)
            else:
                for p in voted_players:
                    if p['votes'][current_round - 1] == 'red':
                        p['balance'] = max(0, p['balance'] - 1000)
                    else:
                        p['balance'] += 1000

    # ===== 游戏结束判断 =====
    if game_won_by_all:
        game_state['game_ended'] = True
        game_state['round_status'] = 'ended'
    else:
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
    top15 = sorted(players.values(), key=lambda x: x['balance'], reverse=True)[:15]
    round_results = None
    
    # ✅ 修复：只有在 current_round > 1 且处于等待/结束状态时才显示上轮结果
    if game_state['current_round'] > 1 and (game_state['round_status'] == 'waiting' or game_state['game_ended']):
        prev_round = game_state['current_round'] - 1
        votes = {'red': 0, 'gold': 0, 'silver': 0}
        for p in players.values():
            if len(p['votes']) >= prev_round:
                apple = p['votes'][prev_round - 1]  # 正确索引：第 prev_round 轮投票在 votes[prev_round-1]
                if apple in votes:
                    votes[apple] += 1
        
        red, gold, silver = votes['red'], votes['gold'], votes['silver']
        total = red + gold + silver
        
        if total == 0:
            msg = "无人投票"
        elif red == total:
            msg = "全体胜利！"
        elif total == 1:
            # 单人投票场景
            if red == 1:
                msg = "唯一玩家投红：全体胜利！"
            else:
                msg = "唯一玩家投金/银：全员-1000"
        elif red == 0:
            if gold < silver:
                msg = "金少胜出：金+1000，银-1000"
            elif silver < gold:
                msg = "银少胜出：银+1000，金-1000"
            else:
                msg = "金银相等：全员-1000"
        else:
            if red < gold and red < silver:
                msg = "红苹果最少：红+1000，金银-1000"
            else:
                msg = "红苹果非最少：红-1000，金银+1000"
        
        round_results = {
            'votes': votes,
            'message': msg
        }
    
    return render_template('display.html',
                           current_round=game_state['current_round'],
                           round_status=game_state['round_status'],
                           game_ended=game_state['game_ended'],
                           top15=top15,
                           round_results=round_results)

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
    total_players = len(players)
    not_voted_count = 0
    remaining_time = None
    if game_state['round_status'] == 'voting' and game_state['voting_start_time']:
        elapsed = time.time() - game_state['voting_start_time']
        remaining_time = max(0, VOTING_DURATION - int(elapsed))
    current_round = game_state['current_round']
    not_voted_count = sum(1 for p in players.values() if len(p['votes']) < current_round)
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
        'voting_start_time': None
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
    if len(player['votes']) >= current_round:
        return jsonify({'success': False, 'message': '你已投票'})
    player['votes'].append(apple)
    save_data()
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

# ===== 启动配置 =====
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
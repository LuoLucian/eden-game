# 🌿 伊甸园游戏 — Render 云端部署教程

> 部署到 Render 后，任何人用手机扫码即可加入，**无需连同一个 WiFi**！

---

## 📋 准备工作（共需约15分钟）

需要注册两个免费账号：
1. **GitHub** — 存放代码（https://github.com）
2. **Render** — 运行游戏服务器（https://render.com）

---

## 第一步：安装 Git 并上传代码到 GitHub

### 1.1 安装 Git

1. 访问 https://git-scm.com/download/win
2. 下载并安装（全部默认，一路 Next）
3. 安装完成后重启命令提示符

### 1.2 注册 GitHub 账号

1. 访问 https://github.com
2. 点击 Sign up，填写邮箱/密码/用户名注册

### 1.3 创建 GitHub 仓库

1. 登录 GitHub 后，点击右上角 **"+"** → **"New repository"**
2. Repository name 填写：`eden-game`
3. 选择 **Public**（公开，Render 免费版需要）
4. 点击 **"Create repository"**
5. 页面会显示一串命令，复制保留备用

### 1.4 创建 Personal Access Token（PAT）

⚠️ **GitHub 已不支持密码推送代码，必须用 PAT 代替密码！**

1. 登录 GitHub → 点击右上角头像 → **Settings**
2. 左侧最底部 → **Developer settings**
3. 选择 **Personal access tokens** → **Tokens (classic)**
4. 点击 **Generate new token** → **Generate new token (classic)**
5. 填写：
   - Note（备注）：`eden-game-deploy`
   - Expiration（过期时间）：选 30 days 或 60 days
   - 勾选 **repo**（完整的仓库访问权限）
6. 点击 **Generate token**
7. ⚠️ **立刻复制这个 token！**（格式类似 `ghp_xxxxxxxxxxxx`，离开页面后无法再看到）

### 1.5 上传代码

打开命令提示符（或 PowerShell），输入以下命令：

```bash
cd C:\Users\DELL\WorkBuddy\Claw\eden-game

git init
git add .
git commit -m "初始化伊甸园游戏"
git branch -M main
git remote add origin https://github.com/你的GitHub用户名/eden-game.git
git push -u origin main
```

当提示输入密码时：
- **Username**：输入你的 GitHub 用户名
- **Password**：**粘贴刚才复制的 PAT**（不是 GitHub 登录密码！）

> 💡 密码输入时屏幕不会显示任何字符，这是正常的，粘贴后直接按回车。

推送成功后，代码就上传到 GitHub 了。

---

## 第二步：部署到 Render

### 2.1 注册 Render 账号

1. 访问 https://render.com
2. 点击 **"Get Started for Free"**
3. 推荐用 GitHub 账号直接登录（点 "Continue with GitHub"）

### 2.2 创建 Web Service

1. 登录后，点击 **"New +"** → **"Web Service"**
2. 选择 **"Build and deploy from a Git repository"**
3. 点击 **"Connect GitHub"**，授权 Render 访问你的 GitHub
4. 找到 `eden-game` 仓库，点击 **"Connect"**

### 2.3 填写部署配置

| 字段 | 填写内容 |
|------|---------|
| Name | `eden-game`（随意） |
| Region | Singapore（亚洲最近） |
| Branch | `main` |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free**（免费） |

### 2.4 点击部署

点击 **"Create Web Service"**，等待 2-3 分钟完成部署。

部署完成后，Render 会给你一个网址，类似：
```
https://eden-game-xxxx.onrender.com
```

---

## 第三步：使用游戏

部署成功后，你的三个端的地址是：

| 端 | 地址 |
|---|---|
| 📺 大屏展示端 | `https://eden-game-xxxx.onrender.com/display/` |
| 🎮 后台控制端 | `https://eden-game-xxxx.onrender.com/admin/` |
| 📱 玩家端 | `https://eden-game-xxxx.onrender.com/player/` |

大屏端会**自动生成二维码**，玩家手机扫码即可加入，**不需要同一局域网**！

---

## ⚠️ 注意事项

### Render 免费版限制
- **休眠机制**：15分钟无访问后服务器会进入休眠，下次访问需要等 30-60 秒启动
- **解决方案**：游戏开始前先打开大屏端，等服务器完全启动再让玩家扫码

### 唤醒服务器（重要）
在活动开始前 **提前 2 分钟**访问大屏端地址唤醒服务器。

### 免费版每月限制
每月 750 小时免费使用时间，日常团建完全够用。

---

## 🔄 更新代码

如果修改了游戏代码，重新上传即可自动部署：

```bash
cd C:\Users\DELL\WorkBuddy\Claw\eden-game
git add .
git commit -m "更新游戏"
git push
```

> 💡 如果 git push 提示输入密码，仍然使用 PAT。

Render 会自动检测到更新并重新部署（约2分钟）。

---

## ❓ 常见问题

### Q：git push 报错 "remote: Support for password authentication was removed"
A：你需要使用 PAT 代替密码，参见 1.4 节创建 PAT。

### Q：部署失败怎么办？
A：在 Render 控制台查看 "Logs"，把错误信息告诉我。

### Q：手机打开链接很慢？
A：免费版服务器在新加坡，国内访问可能稍慢，正常现象。

### Q：100人同时投票会崩吗？
A：Render 免费版单实例处理 100 人 WebSocket 没有问题。

### Q：游戏数据重启后丢失？
A：是的，Render 免费版不持久化内存数据。每次游戏重新开始即可，之后有需要我们可以加数据库。

### Q：怎么删除 GitHub 上的 PAT？
A：GitHub → Settings → Developer settings → Personal access tokens → 找到对应的 token → Delete。建议部署完成后删除旧的 PAT。

---

*伊甸园团建游戏 · 随时随地，全员参与 🌿*

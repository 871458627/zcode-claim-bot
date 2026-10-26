# zcode-claim-bot

云端监控 ZCode 赠送 token 活动：能自动领的自动领取并推送到账通知，被人机验证拦住的静默记录。**本机关机不影响运行**（跑在 GitHub Actions 上）。

> **免责声明 / Disclaimer**
>
> - 本项目为**非官方**工具，仅供学习研究 GitHub Actions 自动化与 HTTP API 调用，使用风险自负；
> - 接口逆向自 ZCode 桌面客户端，**随时可能因平台改版而失效**，不承诺可用性；
> - 自动化领取可能触及平台服务条款，由此产生的账号风控后果由使用者本人承担；
> - **禁止**用于多账号、批量领取或任何滥用场景；
> - 开始使用即表示你已理解并接受上述内容。

## 工作原理

```
GitHub Actions 定时（北京时间 09:00 / 21:00）
    │  GET /api/v1/zcode-plan/billing/preview      （查可领活动）
    ▼
有可领活动？
    ├─ 无人机验证要求 → POST claim → 自动领取 → 推送"到账通知"（数量/模型/有效期/使用规则）
    ├─ 有人机验证 → 静默记录，不推送（可在任意电脑的客户端活动卡片手动点领）
    └─ preview 返回 401 → 凭证过期告警（推送 + GitHub 邮件），重新导出即可
```

接口协议逆向自 ZCode 桌面客户端 v3.16.3（`app.asar`），与客户端行为一致：

- `GET /api/v1/zcode-plan/billing/preview?app_version=&platform=` — 可领活动列表
- `POST /api/v1/zcode-plan/billing/claim` + `{"plan_id": ...}` — 领取
- 鉴权：`Authorization: Bearer <zcodejwttoken>`（即本机 `%USERPROFILE%\.zcode\v2\credentials.json` 里的 `zcodejwttoken` 字段）

### 关于"全自动领取"的边界

部分（start-plan 类）赠送活动的领取被平台强制要求**客户端内人机验证**（验证参数只能由 ZCode 客户端的验证码组件产出），这是平台明确的反自动化设计，本项目**不做绕过**：

- 无验证要求的活动 → 云端直接自动领取，并推送到账通知；
- 有验证码的活动 → 静默记录（不推送），需要时在客户端手动点领。

## 部署步骤

### 1. 建一个 GitHub 私有仓库并推送本目录

> 必须是 **Private**：仓库里要放你自己账号的凭证 secret。Fork 上手也行，但注意 Fork 的定时触发（schedule）默认停用，需在 Actions 页手动启用。

```bash
git init -b main && git add -A && git commit -m "init"
# 在 github.com 新建私有仓库 <user>/zcode-claim-bot 后：
git remote add origin https://github.com/<user>/zcode-claim-bot.git
git push -u origin main
```

### 2. 写入凭证 secret

在装有 ZCode 客户端的电脑上导出 token（不要写进任何文件或聊天记录）：

```bash
python -c "import json,os;print(json.load(open(os.path.expanduser('~/.zcode/v2/credentials.json'),encoding='utf-8'))['zcodejwttoken'])"
```

仓库页面 → Settings → Secrets and variables → Actions → New repository secret：
- `ZCODE_JWT` = 上面导出的 token

### 3. （推荐）配置推送通知

新建 secret `NOTIFY_WEBHOOK`，脚本按 URL 自动识别渠道：

| 渠道 | NOTIFY_WEBHOOK 填法 |
|---|---|
| Server酱（微信） | `https://sctapi.ftqq.com/<SENDKEY>.send` |
| 企业微信群机器人 | 群机器人 Webhook 地址（`qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`） |
| Bark（iOS） | `https://api.day.app/<你的key>` |
| Telegram | `https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>` |
| 钉钉机器人 | 群机器人 Webhook 地址 |
| 飞书机器人 | 群机器人 Webhook 地址 |

### 通知策略

只有两种情况会推送消息：

1. **成功领取到免费 token** —— 通知含到账数量、适用模型、有效期与使用规则；
2. **凭证失效** —— 不告警的话 bot 会静默失联，所以这一条保留。

其余情况（无可领活动、活动需客户端验证码、临时领取失败）一律只写 Actions 日志，不推送。

### 4. 验证

仓库 → Actions → `zcode-claim` → Run workflow 手动触发一次，看日志：

- `claimable plans: N` = 当前可领活动数
- `DRY_RUN would claim: ...` 确认识别正常后，可在本地 `DRY_RUN=1 node claim.mjs` 再核一遍

## 日常维护

- **凭证过期**：脚本 exit 2，GitHub 发失败邮件 + 推送提醒；重新执行部署第 2 步更新 secret 即可。
- **静默失败的可能**：接口字段大改版可能静默跑空 —— 每月看一眼 Actions 运行日志确认 `preview` 仍是 `code 0`。
- keepalive workflow 每月 2 日自动空提交，防止 GitHub 60 天不活跃停用 schedule。

## 安全说明

- 本仓库不包含、也不会收集任何使用者的凭证：JWT 只发送至 `zcode.z.ai` 官方接口，通知内容只有活动信息；
- Actions secrets 为 GitHub 加密存储，仓库公开或私有都不影响其保密性；
- 自查方法：`claim.mjs` 中所有请求目标只有 `BASE`（官方接口）与你自行配置的 `NOTIFY_WEBHOOK`；
- 提 Issue / 讨论时**请勿粘贴**自己的 SendKey 或 zcodejwttoken。

## License

[MIT](LICENSE)

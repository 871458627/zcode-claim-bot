#!/usr/bin/env node
// ZCode 活动额度监控与领取（v3）
// 接口协议逆向自 ZCode 桌面客户端 v3.16.3，与本机客户端行为一致。
//
// 通知策略 v3（2026-10-29 按用户要求调整）:
//   - 自动领取成功 → 推送：具体数量 + 适用模型 + 有效期 + 使用规则
//   - 发现可领活动但被人机验证拦截 → 立即推送（同一活动只推一次），人工在客户端 5 秒领取
//   - marketing/touch 出现新活动投放 → 立即推送（探测源，可能早于领取列表上线）
//   - 无任何可领 → 静默；唯一例外：凭证失效仍推送并 exit 2
//
// 凭证来源（优先级）: 环境变量 ZCODE_JWT → 本机 ~/.zcode/v2/credentials.json（本地任务零维护）
// 推送渠道: 环境变量 NOTIFY_WEBHOOK → 脚本同目录 notify.local 文件（本地任务用）
//
// 用法: node claim.mjs
// 可选: STATE_FILE（默认 ./state.json）、DEVICE_MID、PLATFORM、DRY_RUN=1
// 退出码: 0 正常; 1 未知错误; 2 凭证失效

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const BASE = 'https://zcode.z.ai';
const APP_VERSION = '3.16.3';
const PLATFORM = process.env.PLATFORM || 'win32-x64';
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const DRY_RUN = process.env.DRY_RUN === '1';
const HERE = dirname(fileURLToPath(import.meta.url));

function resolveJwt() {
  const env = (process.env.ZCODE_JWT || '').trim();
  if (env) return env;
  try {
    const p = join(homedir(), '.zcode', 'v2', 'credentials.json');
    const creds = JSON.parse(readFileSync(p, 'utf8'));
    if (creds.zcodejwttoken) return creds.zcodejwttoken;
  } catch { /* no local client */ }
  return '';
}
const JWT = resolveJwt();

function resolveWebhook() {
  const env = (process.env.NOTIFY_WEBHOOK || '').trim();
  if (env) return env;
  try {
    const local = join(HERE, 'notify.local');
    if (existsSync(local)) return readFileSync(local, 'utf8').trim();
  } catch { /* best effort */ }
  return '';
}

if (!JWT) {
  console.error('no ZCODE_JWT (env) and no local credentials.json');
  process.exit(2);
}

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${JWT}`,
    'User-Agent': `ZCode/${APP_VERSION}`,
    'HTTP-Referer': BASE,
    'X-Title': 'Z Code@electron',
    'X-ZCode-App-Version': APP_VERSION,
    'X-Platform': PLATFORM,
    'X-Client-Language': 'zh-CN',
    'X-Device-Mid': process.env.DEVICE_MID || randomUUID(),
    ...extra,
  };
}

async function call(url, opt = {}, retries = 1) {
  for (let i = 0; ; i++) {
    try {
      const h = headers(opt.headers);
      if (opt.body) h['Content-Type'] = 'application/json';
      const res = await fetch(url, { ...opt, headers: h });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-json */ }
      return { status: res.status, json, text };
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

function fmtUnits(n) {
  if (n >= 1e8) return `${+(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${+(n / 1e4).toFixed(1)}万`;
  return `${n}`;
}

const fmtNum = n => Number(n).toLocaleString('en-US');
const fmtTime = ts => new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function entitlementLines(ents) {
  const lines = [];
  for (const e of ents) {
    const n = Number(e.grant_units) || 0;
    const period = e.period === 'one_time' ? '一次性' : (e.period || '').trim();
    lines.push(`· ${e.show_name || '赠送额度'} × ${fmtUnits(n)} ${e.unit_type || ''}（${fmtNum(n)}${period ? '，' + period : ''}）`.trim());
  }
  const caps = [...new Set(ents.flatMap(e => e.capabilities || []))];
  if (caps.length) lines.push(`· 适用模型：${caps.join(', ')}`);
  return lines;
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch { /* corrupted state starts fresh */ }
  return { claimed: [], reported: [], deliveries: [] };
}

function saveState(s) {
  mkdirSync(dirname(STATE_FILE) || '.', { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

async function notify(title, body) {
  const url = resolveWebhook();
  if (!url) return;
  const text = `${title}\n${body}`;
  let opt;
  if (url.includes('sctapi.ftqq.com')) {
    opt = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(body)}` };
  } else if (url.includes('api.day.app')) {
    opt = { method: 'POST', body: JSON.stringify({ title, body }) };
  } else if (url.includes('api.telegram.org')) {
    opt = { method: 'POST', body: JSON.stringify({ text }) };
  } else if (url.includes('qyapi.weixin.qq.com')) {
    opt = { method: 'POST', body: JSON.stringify({ msgtype: 'text', text: { content: text } }) };
  } else if (url.includes('oapi.dingtalk.com')) {
    opt = { method: 'POST', body: JSON.stringify({ msgtype: 'text', text: { content: text } }) };
  } else if (url.includes('open.feishu.cn')) {
    opt = { method: 'POST', body: JSON.stringify({ msg_type: 'text', content: { text } }) };
  } else {
    opt = { method: 'POST', body: JSON.stringify({ title, content: body }) };
  }
  try {
    await call(url, opt, 0);
  } catch (e) {
    console.error('notify failed:', e.message);
  }
}

const summary = [];
function out(line) {
  console.log(line);
  summary.push(line);
}
function flushSummary() {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n'); } catch { /* best effort */ }
  }
}

const now = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

function planBrief(p) {
  const ents = (p.entitlements || [])
    .map(e => `${(e.show_name || '').trim()} ${fmtUnits(Number(e.grant_units) || 0)}${e.unit_type || ''}`.trim())
    .join(' + ');
  return `${(p.name || p.plan_id).trim()}（${ents || '内容未知'}）`;
}

async function main() {
  out(`ZCode claim bot v3 @ ${now()}`);

  const state = loadState();
  state.claimed ||= [];
  state.reported ||= [];
  state.deliveries ||= [];

  // ---------- 源 1: billing/preview（可领活动列表） ----------
  const pv = await call(`${BASE}/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=${PLATFORM}`);
  if (pv.status === 401 || pv.status === 403) {
    await notify('ZCode 凭证已失效', '云端脚本无法通过鉴权（preview 401）。请在装有 ZCode 客户端的电脑重新导出 zcodejwttoken，并更新 GitHub 仓库的 ZCODE_JWT secret。');
    out('RESULT: credential_invalid');
    process.exitCode = 2;
    return;
  }
  if (pv.status !== 200 || pv.json?.code !== 0) {
    out(`preview failed: HTTP ${pv.status} ${pv.text.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const plans = pv.json?.data?.plans || [];
  out(`claimable plans: ${plans.length}${DRY_RUN ? ' (DRY_RUN)' : ''}`);

  for (const plan of plans) {
    const ents = plan.entitlements || [];
    if (state.claimed.includes(plan.plan_id)) { out(`SKIP (already claimed): ${plan.plan_id}`); continue; }
    if (state.reported.includes(plan.plan_id)) { out(`SKIP (needs client captcha, seen before): ${plan.plan_id}`); continue; }

    if (DRY_RUN) { out(`DRY_RUN would claim: ${plan.plan_id}`); continue; }

    const cl = await call(`${BASE}/api/v1/zcode-plan/billing/claim`, {
      method: 'POST',
      body: JSON.stringify({ plan_id: plan.plan_id }),
    });

    if (cl.status === 200 && cl.json?.code === 0) {
      state.claimed.push(plan.plan_id);
      out(`CLAIMED: ${plan.plan_id}`);
      const title = `ZCode 已到账：${ents.map(e => `${fmtUnits(Number(e.grant_units) || 0)}${e.unit_type || ''}`).join(' + ')}`;
      const cp = cl.json?.data?.plan || {};
      const validity = Number.isFinite(cp.starts_at) && Number.isFinite(cp.ends_at)
        ? `${fmtTime(cp.starts_at)} ~ ${fmtTime(cp.ends_at)}（北京时间）`
        : '以活动页说明为准';
      const body = [
        `活动：${plan.name || plan.plan_id}`,
        '到账明细：',
        ...entitlementLines(ents),
        `有效期：${validity}`,
        '使用规则：',
        '· 额度在 ZCode 客户端内使用对应模型时自动扣减，无需手动操作',
        '· 赠送额度与套餐额度相互独立，先用赠额（以平台口径为准）',
        '· 有效期与适用范围详情见 zcode.z.ai 活动页',
      ].join('\n');
      await notify(title, body);
    } else if (cl.status === 401 || cl.status === 403) {
      // 被人机验证拦截 → 立即推送（每活动一次），人工 5 秒领取
      out(`NEEDS_CLIENT: ${plan.plan_id}`);
      if (!state.reported.includes(plan.plan_id)) {
        state.reported.push(plan.plan_id);
        const valid = ents.some(e => (e.period || '') !== '' && e.period !== 'one_time')
          ? '限时/限量活动，建议尽快领取'
          : '限时活动，建议尽快领取';
        await notify('ZCode 发现可领活动，请你点一下 🎁',
          `${planBrief(plan)}\n${valid}\n\n领取方式：打开 ZCode 客户端 → 左下角活动卡片 → 点击领取（约 5 秒，平台要求客户端内人机验证，脚本无法代领）。`);
      }
    } else {
      out(`CLAIM FAILED (will retry next run): HTTP ${cl.status} ${(cl.json?.msg || cl.text).slice(0, 200)} | ${plan.plan_id}`);
    }
  }

  // ---------- 源 2: marketing/touch（活动卡片投放，可能早于领取列表） ----------
  try {
    const mt = await call(`${BASE}/api/v1/marketing/touch?seq=1`);
    if (mt.status === 200 && mt.json?.code === 0) {
      const deliveries = mt.json?.data?.deliveries || [];
      out(`marketing deliveries: ${deliveries.length}`);
      for (const d of deliveries) {
        const id = d.campaign_id || d.id || d.delivery_id || JSON.stringify(d).slice(0, 80);
        if (state.deliveries.includes(id)) continue;
        state.deliveries.push(id);
        if (state.deliveries.length > 100) state.deliveries = state.deliveries.slice(-50);
        const brief = d.title || d.name || d.campaign_name || id;
        out(`NEW DELIVERY: ${brief}`);
        await notify('ZCode 活动卡片有新投放 📣',
          `${brief}\n\n详情打开 ZCode 客户端左下角活动卡片查看；若可领取，客户端内点击即可。`);
      }
    } else {
      out(`marketing/touch: HTTP ${mt.status} (ignored)`);
    }
  } catch (e) {
    out(`marketing/touch error (ignored): ${e.message}`);
  }

  saveState(state);
  out(`RESULT: claimed=${state.claimed.length} needs_client=${state.reported.length} deliveries_seen=${state.deliveries.length}`);
}

try {
  await main();
} catch (e) {
  console.error('unexpected error:', e);
  process.exitCode = 1;
}
flushSummary();

#!/usr/bin/env node
// ZCode 活动额度监控与领取（云端版）
// 接口协议逆向自 ZCode 桌面客户端 v3.16.3，与本机客户端行为一致。
//
// 通知策略:
//   - 成功领取到免费 token 时才推送：具体数量 + 适用模型 + 有效期 + 使用规则
//   - 其余情况（无可领 / 需客户端验证码 / 临时失败）一律静默，只写日志
//   - 例外：凭证失效仍推送并 exit 2（否则 bot 静默失联无人知晓）
//
// 用法:
//   ZCODE_JWT=<zcodejwttoken> node claim.mjs
// 可选环境变量:
//   NOTIFY_WEBHOOK   推送渠道（Server酱/Bark/Telegram/企业微信群机器人/钉钉/飞书，其它 URL 走通用 JSON POST）
//   STATE_FILE       去重状态文件路径（默认 ./state.json，配合 Actions cache 使用）
//   DEVICE_MID       设备标识（默认随机 UUID，仅用于服务端埋点）
//   PLATFORM         X-Platform 头（默认 win32-x64，与导出凭证的客户端保持一致）
//   DRY_RUN          设为 1 时只查询不领取
//
// 退出码: 0 正常（无论是否领到）; 1 预览/未知错误（触发 GitHub 失败邮件）; 2 凭证失效（需重新导出）

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE = 'https://zcode.z.ai';
const APP_VERSION = '3.16.3';
const PLATFORM = process.env.PLATFORM || 'win32-x64';
const JWT = (process.env.ZCODE_JWT || '').trim();
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!JWT) {
  console.error('missing ZCODE_JWT');
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
      try { json = JSON.parse(text); } catch { /* non-json body */ }
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
  return { claimed: [], reported: [] };
}

function saveState(s) {
  mkdirSync(dirname(STATE_FILE) || '.', { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

async function notify(title, body) {
  const url = (process.env.NOTIFY_WEBHOOK || '').trim();
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

async function main() {
  out(`ZCode claim bot @ ${now()}`);

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
  if (plans.length === 0) {
    out('RESULT: nothing_to_claim');
    return;
  }

  const state = loadState();
  state.claimed ||= [];
  state.reported ||= [];

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
      // preview 已通过而 claim 被拒 => 该活动启用了人机验证，只能客户端内领取；按策略静默
      state.reported.push(plan.plan_id);
      out(`NEEDS_CLIENT (silent): ${plan.plan_id}`);
    } else {
      out(`CLAIM FAILED (silent, will retry next run): HTTP ${cl.status} ${(cl.json?.msg || cl.text).slice(0, 200)} | ${plan.plan_id}`);
    }
  }

  saveState(state);
  out(`RESULT: claimed=${state.claimed.length} needs_client=${state.reported.length}`);
}

try {
  await main();
} catch (e) {
  console.error('unexpected error:', e);
  process.exitCode = 1;
}
flushSummary();

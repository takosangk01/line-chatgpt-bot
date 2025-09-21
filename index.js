// index.js
require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generatePDF } = require('./pdfGenerator');
const { uploadPDF } = require('./uploader');

// ==============================
//  秘密情報マスク & 安全ログ
// ==============================
function maskSecrets(s = '') {
  try {
    return String(s)
      // OpenAI key sk- / sk-proj- 前半だけ残して伏字
      .replace(/(sk-(?:proj-)?)[A-Za-z0-9_\-]{8,}/g, '$1********')
      // Bearer ヘッダ
      .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Authorization: Bearer ********');
  } catch {
    return '***';
  }
}
function safeLog(label, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  console.log(label, maskSecrets(text));
}
function safeError(label, err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const msg = err?.message;
  safeLog(`${label} status=`, String(status || ''));
  safeLog(`${label} data=`, data || {});
  safeLog(`${label} message=`, msg || '');
}

// ==============================
//  環境変数チェック
// ==============================
const requiredEnvVars = ['CHANNEL_ACCESS_TOKEN', 'CHANNEL_SECRET', 'OPENAI_API_KEY'];
const missingVars = requiredEnvVars.filter((varName) => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ 必要な環境変数が設定されていません:', missingVars);
  process.exit(1);
}
console.log('✅ 環境変数チェック完了');

// ==============================
//  LINE SDK 初期化
// ==============================
const app = express();
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// ==============================
//  必要ファイルの存在・読込（UTF-8）
// ==============================
const requiredFiles = [
  path.join(__dirname, 'data', 'corrected_animal_map_60.json'),
  path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json'),
];

let animalMap, stemMap;

try {
  console.log('必要なファイルを読み込み中...');
  requiredFiles.forEach((file) => {
    if (!fs.existsSync(file)) {
      throw new Error(`必要なファイルが見つかりません: ${file}`);
    }
  });

  // JSONは必ず utf8 で文字列読込
  animalMap = JSON.parse(fs.readFileSync(requiredFiles[0], 'utf8'));
  stemMap = JSON.parse(fs.readFileSync(requiredFiles[1], 'utf8'));

  console.log('✅ データファイルの読み込み完了');
} catch (error) {
  console.error('❌ データファイルの読み込みエラー:', error.message);
  process.exit(1);
}

// ==============================
//  タイトル定義（LINE表示用）
// ==============================
const titleMap = {
  '無料トータル診断': '◆◆ あなただけのトータル分析 ◆◆',
};

// ==============================
//  シグネチャ検証（必要なら手動検証）
// ==============================
function validateSignature(req) {
  const signature = req.headers['x-line-signature'];
  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', process.env.CHANNEL_SECRET).update(body).digest('base64');
  return signature === hash;
}

// ==============================
//  テキスト抽出系
// ==============================
function extractDiagnosisName(input) {
  return input.match(/《《《(.+?)》》》/)?.[1]?.trim() || null;
}

function extractUserData(input) {
  console.log('extractUserData: 入力データ -', input);

  // パターン1: 生年月日：YYYY年MM月DD日 + MBTI：XXXX
  let match = input.match(/生年月日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  let mbtiMatch = input.match(/MBTI[：:]\s*([A-Z]{4})/i);

  if (match && mbtiMatch) {
    const [, y, m, d] = match;
    const mbti = (mbtiMatch[1] || '').toUpperCase();
    const question = input.match(/・お悩み\s*(.+)/)?.[1]?.trim();

    console.log('extractUserData: パターン1で抽出成功 -', {
      year: +y,
      month: +m,
      day: +d,
      mbti,
      question,
    });
    return { year: +y, month: +m, day: +d, mbti, question };
  }

  // パターン2: YYYY年MM月DD日 XXXX（従来）
  match = input.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[\s\n　]*([A-Z]{4})/i);
  if (match) {
    const [, y, m, d, mbtiRaw] = match;
    const mbti = (mbtiRaw || '').toUpperCase();
    const question = input.match(/・お悩み\s*(.+)/)?.[1]?.trim();

    console.log('extractUserData: パターン2で抽出成功 -', {
      year: +y,
      month: +m,
      day: +d,
      mbti,
      question,
    });
    return { year: +y, month: +m, day: +d, mbti, question };
  }

  console.log('extractUserData: どのパターンにもマッチしませんでした。');
  return null;
}

// ==============================
//  干支/日干からの属性算出（UTCで計算）
// ==============================
function toUTCDate(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}
function daysBetweenUTC(a, b) {
  return Math.floor((a.getTime() - b.getTime()) / 86400000);
}

function getAttributes(year, month, day) {
  // UTC計算で1日ズレ抑止
  const baseDate = toUTCDate(1986, 2, 4); // 1986-02-04
  const targetDate = toUTCDate(year, month, day);
  const diff = daysBetweenUTC(targetDate, baseDate);
  const eto = ((diff % 60 + 60) % 60) + 1;

  const tenStemBase = toUTCDate(1873, 1, 12); // 1873-01-12
  const stemIndex = ((daysBetweenUTC(targetDate, tenStemBase) % 10) + 10) % 10;
  const stems = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const stem = stems[stemIndex];

  const info = stemMap.find((e) => e.day_stem === stem) || {};
  return {
    animal: animalMap.find((e) => +e.干支番号 === eto)?.動物 || '不明',
    stem,
    element: info.element || '不明',
    guardian: info.guardian_spirit || '不明',
  };
}

// ==============================
//  変数置換（${...}のみ置換）
// ==============================
function replaceVars(str, vars) {
  return String(str || '').replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (match, key) => {
    console.log(`変数置換: ${key}`);
    const keys = key.split('.');
    let value = vars;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) {
        console.log(`変数 ${key} が見つかりません。未展開のまま残します`);
        return match; // 未定義は残す
      }
    }
    const result = String(value);
    console.log(`${key} = "${result}"`);
    return result;
  });
}

// ==============================
//  拒否検知 & サニタイズ
// ==============================
function isRefusal(text = '') {
  const needles = [
    '申し訳ありませんが、そのリクエストには対応できません',
    '対応できません',
    "I can't help with that",
    'I can’t help with that',
    'cannot help with',
    'cannot comply',
    'refuse to comply',
  ];
  return needles.some((n) => text.includes(n));
}

// 表層トリガーになりやすい語を無害化（意味は維持）
function sanitizePrompt(p) {
  return String(p || '')
    .replaceAll(/診断/g, '自己理解ノート')
    .replaceAll(/レポート/g, 'ノート')
    .replaceAll(/占い/g, '文化的メタファ')
    .replaceAll(/医療|心理|宗教|疾患|治療/g, '専門領域');
}

// ==============================
//  OpenAI 呼び出し（リトライ付き）
// ==============================
async function callOpenAI(system, userContent) {
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: 0.6,
      max_tokens: 2200, // レート/費用負荷を抑制
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return resp.data.choices?.[0]?.message?.content || '';
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callOpenAIWithRetry(system, userContent, retries = 2, initialDelayMs = 800) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await callOpenAI(system, userContent);
    } catch (err) {
      const status = err?.response?.status;
      const retryAfter = parseInt(err?.response?.headers?.['retry-after'] || '0', 10);
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || i === retries) {
        safeError('OpenAI error (give up)', err);
        throw err;
      }
      const wait = retryAfter ? retryAfter * 1000 : initialDelayMs * Math.pow(2, i); // 0.8s→1.6s→3.2s
      safeLog('OpenAI retry wait(ms)=', wait);
      await sleep(wait);
    }
  }
}

// ==============================
//  ユーザー単位の直列化 & 二重実行ガード
// ==============================
const userLocks = new Map(); // userId -> Promise
async function runExclusive(userId, taskFn) {
  const prev = userLocks.get(userId) || Promise.resolve();
  let resolve;
  const p = new Promise((r) => (resolve = r));
  userLocks.set(userId, prev.finally(() => p));
  try {
    return await taskFn();
  } finally {
    resolve();
    if (userLocks.get(userId) === p) userLocks.delete(userId);
  }
}

const recentJobs = new Map(); // key -> timestamp
const JOB_TTL = 2 * 60 * 1000; // 2分

function makeJobKey(userId, diagnosis, userData) {
  return `${userId}|${diagnosis}|${userData.year}-${userData.month}-${userData.day}|${userData.mbti}`;
}
function shouldSkipJob(key) {
  const now = Date.now();
  for (const [k, t] of recentJobs) if (now - t > JOB_TTL) recentJobs.delete(k);
  if (recentJobs.has(key)) return true;
  recentJobs.set(key, now);
  return false;
}

// ==============================
//  ヘルスチェック
// ==============================
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'LINE診断システムが正常に動作しています',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// ==============================
//  Webhook
// ==============================
app.post('/webhook', middleware(config), async (req, res) => {
  // 必要なら手動検証:
  // if (!validateSignature(req)) return res.status(403).send('Invalid signature');

  for (const event of req.body.events) {
    await runExclusive(event.source.userId || 'unknown', async () => {
      // LSTEPへ転送（任意）
      if (process.env.LSTEP_WEBHOOK_URL && process.env.LSTEP_WEBHOOK_URL.startsWith('http')) {
        try {
          await axios.post(process.env.LSTEP_WEBHOOK_URL, { events: [event] });
        } catch (e) {
          console.log('LSTEP webhook error:', e.message);
        }
      }

      if (event.type !== 'message' || event.message.type !== 'text') return;

      const input = event.message.text;
      const diagnosis = extractDiagnosisName(input);

      // 診断名がなければ通常メッセージとしてスキップ
      if (!diagnosis) {
        console.log('通常のメッセージを受信（診断対象外）:', input);
        return;
      }

      // 入力抽出
      const userData = extractUserData(input);
      if (!userData) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '入力に不備があります。もう一度お試しくださいm(_ _)m',
        });
        return;
      }

      // 二重実行ガード（直近2分同一内容はスキップ）
      const jobKey = makeJobKey(event.source.userId, diagnosis, userData);
      if (shouldSkipJob(jobKey)) {
        console.log('Duplicate job skipped:', jobKey);
        return;
      }

      // 受付メッセージ（replyで即時）
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '🐻‍❄️ 分析を作成中です…',
      });

      try {
        // プロフィール取得（失敗しても処理続行）
        let userName = 'あなた';
        try {
          const profile = await client.getProfile(event.source.userId);
          userName = profile?.displayName || userName;
        } catch {
          /* noop */
        }

        const userAttr = getAttributes(userData.year, userData.month, userData.day);

        // プロンプトファイル読込
        const promptFilePath = path.join(__dirname, 'prompts', 'muryo_total.json');
        if (!fs.existsSync(promptFilePath)) {
          throw new Error(`プロンプトファイルが見つかりません: ${promptFilePath}`);
        }
        const promptData = JSON.parse(fs.readFileSync(promptFilePath, 'utf8'));

        // 変数構築
        const vars = {
          user: {
            mbti: userData.mbti,
            year: userData.year,
            month: userData.month,
            day: userData.day,
            gender: userData.gender || null,
          },
          attrs: {
            animal: userAttr.animal,
            stem: userAttr.stem,
            element: userAttr.element,
            guardian: userAttr.guardian,
          },
          question: userData.question || '―',
        };

        console.log('作成された変数:', JSON.stringify(vars, null, 2));

        // サマリー
        const summary = promptData.summaryBlockTemplate
          ? replaceVars(promptData.summaryBlockTemplate, vars)
          : `◆ MBTI：${userData.mbti}\n◆ 動物占い：${userAttr.animal}\n◆ 算命学：${userAttr.stem}（五行：${userAttr.element}／守護神：${userAttr.guardian}）\n◆ お悩み：${userData.question || '―'}`;

        vars.summary = summary;

        // プロンプト構築
        const useTpl = replaceVars(promptData.usePromptTemplate || '', vars);
        const extra = replaceVars(promptData.extraInstruction || '', vars);
        const struct = replaceVars((promptData.structureGuide || []).join('\n'), vars);
        const prompt = `${useTpl}\n\n${extra}\n\n${struct}`;

        // OpenAI呼び出し（通常 → 拒否なら安全版で1回だけ再試行）
        safeLog('=== API呼び出し開始 === プロンプト長:', String(prompt.length));
        safeLog('プロンプト先頭500:', prompt.substring(0, 500));
        safeLog('API KEY先頭10文字:', process.env.OPENAI_API_KEY?.substring(0, 10));

        const baseSystem =
          'これは創作的な「自己理解ノート」です。' +
          '専門的助言や評価には踏み込まず、日常で役立つ視点をやさしく紹介してください。' +
          '危険・違法・差別的内容は扱わず、具体例は日常範囲に限定。' +
          '断定やレッテルではなく、穏やかな提案と少量の問いかけで。';

        let advice = await callOpenAIWithRetry(baseSystem, prompt);
        safeLog('=== API成功(1) 先頭200 ===', advice.substring(0, 200));

        if (isRefusal(advice)) {
          console.log('⚠️ 拒否を検知。安全版プロンプトで再試行します。');
          const saferSystem =
            'これはフィクションとしての「自己理解ノート」です。' +
            '専門分野の助言/診断/評価は行わず、一般情報として穏やかな提案のみ。' +
            '判断やレッテルは避け、やさしいトーンと日常の具体例に限定。';
          const saferUser = sanitizePrompt(prompt);

          advice = await callOpenAIWithRetry(saferSystem, saferUser);
          safeLog('=== API成功(リトライ) 先頭200 ===', advice.substring(0, 200));
        }

        if (isRefusal(advice)) {
          throw new Error('モデルが安全上の理由で出力を拒否しました（2回試行）。');
        }

        // PDF生成 & アップロード
        const filename = `${event.source.userId}_${Date.now()}.pdf`;
        const filepath = await generatePDF(
          `${titleMap[diagnosis]}\n${summary}`,
          advice,
          filename,
          path.join(__dirname, 'templates', 'shindan01-top.pdf'),
          titleMap[diagnosis]
        );
        const fileUrl = await uploadPDF(filepath);

        // ユーザーへ送付
        await client.pushMessage(event.source.userId, [
          {
            type: 'text',
            text: `🐻‍❄️ ${userName}さん、お待たせしました！\n分析結果のPDFが完成しました📄✨\n\nこちらからご確認ください：`,
          },
          { type: 'text', text: fileUrl },
        ]);
      } catch (error) {
        safeError('Error processing diagnosis', error);
        await client.pushMessage(event.source.userId, [
          {
            type: 'text',
            text:
              '🐻‍❄️ すみません、文章の作成に失敗しました。\n' +
              '少し表現を変えて再作成を試してみます。時間をおいてもう一度お試しください。',
          },
        ]);
      }
    });
  }

  res.status(200).send('OK');
});

// ==============================
//  サーバ起動
// ==============================
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`✅ Server running on ${port}`));

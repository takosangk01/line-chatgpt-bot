require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generatePDF } = require('./pdfGenerator');
const { uploadPDF } = require('./uploader');

// 環境変数のチェック
const requiredEnvVars = ['CHANNEL_ACCESS_TOKEN', 'CHANNEL_SECRET', 'OPENAI_API_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('❌ 必要な環境変数が設定されていません:', missingVars);
  process.exit(1);
}

console.log('✅ 環境変数チェック完了');

const app = express();
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);

// 必要なファイルの存在チェック
const requiredFiles = [
  path.join(__dirname, 'data', 'corrected_animal_map_60.json'),
  path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json')
];

let animalMap, stemMap;

try {
  console.log('必要なファイルを読み込み中...');
  
  requiredFiles.forEach(file => {
    if (!fs.existsSync(file)) {
      throw new Error(`必要なファイルが見つかりません: ${file}`);
    }
  });
  
  animalMap = JSON.parse(fs.readFileSync(requiredFiles[0]));
  stemMap = JSON.parse(fs.readFileSync(requiredFiles[1]));
  
  console.log('✅ データファイルの読み込み完了');
} catch (error) {
  console.error('❌ データファイルの読み込みエラー:', error.message);
  process.exit(1);
}

const titleMap = {
  '無料トータル診断': '◆◆ あなただけのトータル診断 ◆◆',
  '自分診断': '◆◆ あなただけのプレミアム診断 ◆◆',
  '相性診断': '◆◆ ふたりの相性診断 ◆◆',
  '取扱説明書プレミアム': '◆◆ あなただけの取扱説明書 ◆◆'
};

function validateSignature(req) {
  const signature = req.headers['x-line-signature'];
  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', process.env.CHANNEL_SECRET).update(body).digest('base64');
  return signature === hash;
}

function extractDiagnosisName(input) {
  return input.match(/《《《(.+?)》》》/)?.[1]?.trim() || null;
}

function extractUserData(input) {
  console.log('extractUserData: 入力データ -', input);
  
  // パターン1: 生年月日：YYYY年MM月DD日 + MBTI：XXXX 形式
let match = input.match(/生年月日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
let mbtiMatch = input.match(/MBTI[：:]\s*([A-Z]{4})/i);  // ← iフラグ

if (match && mbtiMatch) {
  const [, y, m, d] = match;
  const mbti = (mbtiMatch[1] || "").toUpperCase();
  const question = input.match(/・お悩み\s*(.+)/)?.[1]?.trim();

  console.log('extractUserData: パターン1で抽出成功 -', { year: +y, month: +m, day: +d, mbti, question });
  return { year: +y, month: +m, day: +d, mbti, question };
}
  
  // パターン2: YYYY年MM月DD日 XXXX 形式（従来のパターン）
  match = input.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[\s\n　]*([A-Z]{4})/);
  if (match) {
    const [, y, m, d, mbti] = match;
    const question = input.match(/・お悩み\s*(.+)/)?.[1]?.trim();
    
    console.log('extractUserData: パターン2で抽出成功 -', { year: +y, month: +m, day: +d, mbti, question });
    return { year: +y, month: +m, day: +d, mbti, question };
  }
  
  console.log('extractUserData: どのパターンにもマッチしませんでした。');
  return null;
}

function extractMatchData(input) {
  console.log('extractMatchData: 入力データ -', input);
  
  // パターン1: 生年月日とMBTIが別行の形式
  const uDateMatch = input.match(/・自分[\s\n]*生年月日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const uMbtiMatch = input.match(/・自分.*?MBTI[：:]\s*([A-Z]{4})/s);
  const uGenderMatch = input.match(/・自分.*?性別[：:]\s*(\S+)/s) || input.match(/・自分.*?([男女性])/);
  
  const pDateMatch = input.match(/・相手[\s\n]*生年月日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const pMbtiMatch = input.match(/・相手.*?MBTI[：:]\s*([A-Z]{4})/s);
  const pGenderMatch = input.match(/・相手.*?性別[：:]\s*(\S+)/s) || input.match(/・相手.*?([男女性])/);
  
  // パターン2: 従来の1行形式
  const u = input.match(/・自分\s+(\d{4})年(\d{1,2})月(\d{1,2})日[\s\n　]*([A-Z]{4})[\s\n　]*(\S+)/);
  const p = input.match(/・相手\s+(\d{4})年(\d{1,2})月(\d{1,2})日[\s\n　]*([A-Z]{4})[\s\n　]*(\S+)/);
  
  const topic = input.match(/・二人の関係性\s*(.+)/)?.[1]?.trim();
  
  let user, partner;
  
  // パターン1で解析
  if (uDateMatch && uMbtiMatch && pDateMatch && pMbtiMatch) {
    user = { 
      year: +uDateMatch[1], 
      month: +uDateMatch[2], 
      day: +uDateMatch[3], 
      mbti: uMbtiMatch[1], 
      gender: uGenderMatch?.[1] || '不明' 
    };
    partner = { 
      year: +pDateMatch[1], 
      month: +pDateMatch[2], 
      day: +pDateMatch[3], 
      mbti: pMbtiMatch[1], 
      gender: pGenderMatch?.[1] || '不明' 
    };
  }
  // パターン2で解析
  else if (u && p) {
    user = { year: +u[1], month: +u[2], day: +u[3], mbti: u[4], gender: u[5] };
    partner = { year: +p[1], month: +p[2], day: +p[3], mbti: p[4], gender: p[5] };
  }
  
  if (!user || !partner || !topic) {
    console.log('extractMatchData: マッチしませんでした。');
    console.log('自分:', user);
    console.log('相手:', partner);
    console.log('関係性:', topic);
    return null;
  }
  
  const result = { user, partner, topic };
  console.log('extractMatchData: 抽出成功 -', result);
  return result;
}

function getAttributes(year, month, day) {
  const baseDate = new Date(1986, 1, 4);
  const targetDate = new Date(year, month - 1, day);
  const diff = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const eto = ((diff % 60 + 60) % 60) + 1;
  const stem = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'][(
    Math.floor((targetDate - new Date(1873, 0, 12)) / 86400000) % 10 + 10) % 10];
  const info = stemMap.find(e => e.day_stem === stem) || {};
  return {
    animal: animalMap.find(e => +e.干支番号 === eto)?.動物 || '不明',
    stem,
    element: info.element || '不明',
    guardian: info.guardian_spirit || '不明'
  };
}

function normalizeText(input) {
  return (input ?? "").toString().normalize("NFKC").trim();
}

function getPromptFilePath(nameRaw) {
  const name = normalizeText(nameRaw);
  if (!name) return null;

  if (name.includes('無料トータル診断')) return 'muryo_total.json';
  if (name.includes('自分診断'))         return 'premium_trial.json';
  if (name.includes('相性診断'))         return 'premium_match_trial.json';
  if (name.includes('取扱説明書プレミアム')) return 'premium_manual.json';
  return null;
}

function replaceVars(str, vars) {
  return str.replace(/\$\{(.*?)\}/g, (match, key) => {
    console.log(`変数置換: ${key}`);
    
    // ネストされたオブジェクトのアクセスをサポート
    const keys = key.split('.');
    let value = vars;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) {
        console.log(`変数 ${key} が見つかりません。現在の値:`, value);
        break;
      }
    }
    
    const result = value || '';
    console.log(`${key} = "${result}"`);
    return result;
  }).replace(/\{(.*?)\}/g, (match, key) => {
    console.log(`変数置換({}): ${key}`);
    
    // ネストされたオブジェクトのアクセスをサポート
    const keys = key.split('.');
    let value = vars;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) {
        console.log(`変数 ${key} が見つかりません。現在の値:`, value);
        break;
      }
    }
    
    const result = value || '';
    console.log(`${key} = "${result}"`);
    return result;
  });
}

// ヘルスチェックエンドポイント
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'LINE診断システムが正常に動作しています',
    timestamp: new Date().toISOString()
  });
});

// ヘルスチェック用
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.post('/webhook', middleware(config), async (req, res) => {
  if (!validateSignature(req)) return res.status(403).send('Invalid signature');

  for (const event of req.body.events) {
    // LSTEPのWebhook送信（URLが設定されている場合のみ）
    if (process.env.LSTEP_WEBHOOK_URL && process.env.LSTEP_WEBHOOK_URL.startsWith('http')) {
      try { 
        await axios.post(process.env.LSTEP_WEBHOOK_URL, { events: [event] }); 
      } catch (e) {
        console.log('LSTEP webhook error:', e.message);
      }
    }
    
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const input = event.message.text;
    const diagnosis = extractDiagnosisName(input) ?? "";
    const promptFile = getPromptFilePath(diagnosis);

    let user, partner, topic, question;
    
    if (diagnosis.includes('相性診断')) {
      const data = extractMatchData(input);
      if (!data) {
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '入力に不備があります。もう一度お試しくださいm(_ _)m' 
        });
      }
      ({ user, partner, topic } = data);
    } else {
      const data = extractUserData(input);
      if (!data) {
        return client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '入力に不備があります。もう一度お試しくださいm(_ _)m' 
        });
      }
      user = data; 
      question = data.question;
    }

    await client.replyMessage(event.replyToken, { 
      type: 'text', 
      text: '🐻‍❄️ 診断を作成中です…' 
    });

    try {
      const profile = await client.getProfile(event.source.userId);
      const userName = profile.displayName;
      const userAttr = getAttributes(user.year, user.month, user.day);
      const partnerAttr = partner ? getAttributes(partner.year, partner.month, partner.day) : {};

      // プロンプトファイルを読み込み
      const promptFilePath = path.join(__dirname, 'prompts', promptFile);
      if (!fs.existsSync(promptFilePath)) {
        throw new Error(`プロンプトファイルが見つかりません: ${promptFilePath}`);
      }
      
      const promptData = JSON.parse(fs.readFileSync(promptFilePath, 'utf8'));
      
      // プロンプトファイルの構造に合わせて変数を構築
      const vars = {
        // プロンプトファイルで使用される変数名に合わせる
        user: {
          mbti: user.mbti,
          year: user.year,
          month: user.month,
          day: user.day,
          gender: user.gender || null
        },
        attrs: {
          animal: userAttr.animal,
          stem: userAttr.stem,
          element: userAttr.element,
          guardian: userAttr.guardian
        },
        // 相性診断用の変数
        partner: partner ? {
          mbti: partner.mbti,
          year: partner.year,
          month: partner.month,
          day: partner.day,
          gender: partner.gender
        } : null,
        partnerAttrs: partner ? {
          animal: partnerAttr.animal,
          stem: partnerAttr.stem,
          element: partnerAttr.element,
          guardian: partnerAttr.guardian
        } : null,
        // 共通変数
        question: question || topic || '―',
        topic: topic || '―'
      };

      console.log('作成された変数:', JSON.stringify(vars, null, 2));

      // プロンプトファイルのsummaryBlockTemplateを使用してサマリーを作成
      let summary;
      if (diagnosis.includes('相性診断')) {
        // 相性診断用のサマリー（既存のロジックを維持）
        summary = `◆ あなた：${user.mbti}/${user.gender}/${user.year}年${user.month}月${user.day}日 動物：${userAttr.animal} 算命：${userAttr.stem}（${userAttr.element}/${userAttr.guardian}）\n◆ 相手：${partner.mbti}/${partner.gender}/${partner.year}年${partner.month}月${partner.day}日 動物：${partnerAttr.animal} 算命：${partnerAttr.stem}（${partnerAttr.element}/${partnerAttr.guardian}）\n◆ 関係性：${topic}`;
      } else {
        // 個人診断用：プロンプトファイルのsummaryBlockTemplateを使用
        summary = promptData.summaryBlockTemplate ? 
          replaceVars(promptData.summaryBlockTemplate, vars) :
          `◆ MBTI：${user.mbti}\n◆ 動物占い：${userAttr.animal}\n◆ 算命学：${userAttr.stem}（五行：${userAttr.element}／守護神：${userAttr.guardian}）\n◆ お悩み：${question || '―'}`;
      }

      // varsにsummaryを追加
      vars.summary = summary;

      // プロンプトを構築
      const prompt = `${promptData.usePromptTemplate}\n\n${promptData.extraInstruction}\n\n${replaceVars(promptData.structureGuide.join('\n'), vars)}`;

      // OpenAI API呼び出し
      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6,
        max_tokens: 4000
      }, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const advice = aiRes.data.choices[0].message.content;
      const filename = `${event.source.userId}_${Date.now()}.pdf`;
      const filepath = await generatePDF(
        `${titleMap[diagnosis]}\n${summary}`, 
        advice, 
        filename, 
        path.join(__dirname, 'templates', 'shindan01-top.pdf'), 
        titleMap[diagnosis]
      );
      const fileUrl = await uploadPDF(filepath);

      await client.pushMessage(event.source.userId, [
        { type: 'text', text: `🐻‍❄️ ${userName}さん、お待たせしました！\n診断結果のPDFが完成しました📄✨\n\nこちらからご確認ください：` },
        { type: 'text', text: fileUrl }
      ]);

    } catch (error) {
      console.error('Error processing diagnosis:', error);
      await client.pushMessage(event.source.userId, [
        { type: 'text', text: '🐻‍❄️ 申し訳ございません。診断の処理中にエラーが発生しました。もう一度お試しください。' }
      ]);
    }
  }

  res.status(200).send('OK');
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`✅ Server running on ${port}`));

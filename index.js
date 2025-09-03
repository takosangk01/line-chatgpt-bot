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
      throw new Error('必要なファイルが見つかりません: ' + file);
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
  const match = input.match(/《《《(.+?)》》》/);
  return match ? match[1].trim() : null;
}

function extractUserData(input) {
  console.log('extractUserData: 入力データ -', input);
  
  // パターン1: 生年月日：YYYY年MM月DD日 + MBTI：XXXX 形式
  let match = input.match(/生年月日[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  let mbtiMatch = input.match(/MBTI[：:]\s*([A-Z]{4})/i);

  if (match && mbtiMatch) {
    const y = match[1];
    const m = match[2];
    const d = match[3];
    const mbti = (mbtiMatch[1] || "").toUpperCase();
    const questionMatch = input.match(/・お悩み\s*(.+)/);
    const question = questionMatch ? questionMatch[1].trim() : undefined;

    console.log('extractUserData: パターン1で抽出成功 -', { year: +y, month: +m, day: +d, mbti, question });
    return { year: +y, month: +m, day: +d, mbti, question };
  }
  
  // パターン2: YYYY年MM月DD日 XXXX 形式（従来のパターン）
  match = input.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[\s\n　]*([A-Z]{4})/);
  if (match) {
    const y = match[1];
    const m = match[2];
    const d = match[3];
    const mbti = match[4];
    const questionMatch = input.match(/・お悩み\s*(.+)/);
    const question = questionMatch ? questionMatch[1].trim() : undefined;
    
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
  
  const topicMatch = input.match(/・二人の関係性\s*(.+)/);
  const topic = topicMatch ? topicMatch[1].trim() : undefined;
  
  let user, partner;
  
  // パターン1で解析
  if (uDateMatch && uMbtiMatch && pDateMatch && pMbtiMatch) {
    user = { 
      year: +uDateMatch[1], 
      month: +uDateMatch[2], 
      day: +uDateMatch[3], 
      mbti: uMbtiMatch[1], 
      gender: uGenderMatch ? uGenderMatch[1] : '不明'
    };
    partner = { 
      year: +pDateMatch[1], 
      month: +pDateMatch[2], 
      day: +pDateMatch[3], 
      mbti: pMbtiMatch[1], 
      gender: pGenderMatch ? pGenderMatch[1] : '不明'
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
  const stemIndex = Math.floor((targetDate - new Date(1873, 0, 12)) / 86400000) % 10;
  const stemList = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  const stem = stemList[(stemIndex + 10) % 10];
  const info = stemMap.find(e => e.day_stem === stem) || {};
  const etoAnimal = animalMap.find(e => +e.干支番号 === eto);
  
  return {
    animal: etoAnimal ? etoAnimal.動物 : '不明',
    stem: stem,
    element: info.element || '不明',
    guardian: info.guardian_spirit || '不明'
  };
}

function normalizeText(input) {
  const text = input != null ? input : "";
  return text.toString().normalize("NFKC").trim();
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
  // ${} パターンの置換
  let result = str.replace(/\$\{(.*?)\}/g, function(match, key) {
    console.log('変数置換: ' + key);
    
    const keys = key.split('.');
    let value = vars;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      value = value ? value[k] : undefined;
      if (value === undefined) {
        console.log('変数 ' + key + ' が見つかりません。');
        break;
      }
    }
    
    const finalValue = value || '';
    console.log(key + ' = "' + finalValue + '"');
    return finalValue;
  });
  
  // {} パターンの置換
  result = result.replace(/\{(.*?)\}/g, function(match, key) {
    console.log('変数置換({}): ' + key);
    
    const keys = key.split('.');
    let value = vars;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      value = value ? value[k] : undefined;
      if (value === undefined) {
        console.log('変数 ' + key + ' が見つかりません。');
        break;
      }
    }
    
    const finalValue = value || '';
    console.log(key + ' = "' + finalValue + '"');
    return finalValue;
  });
  
  return result;
}

// ヘルスチェックエンドポイント
app.get('/', function(req, res) {
  res.status(200).json({ 
    status: 'OK', 
    message: 'LINE診断システムが正常に動作しています',
    timestamp: new Date().toISOString()
  });
});

// ヘルスチェック用
app.get('/health', function(req, res) {
  res.status(200).json({ status: 'healthy' });
});

app.post('/webhook', middleware(config), async function(req, res) {
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
    const diagnosis = extractDiagnosisName(input);
    
    // 診断名が含まれていない場合は、通常のメッセージとして処理をスキップ
    if (!diagnosis) {
      console.log('通常のメッセージを受信（診断対象外）:', input);
      continue;
    }
    
    // 診断名があるが、対応するプロンプトファイルがない場合
    const promptFile = getPromptFilePath(diagnosis);
    if (!promptFile) {
      console.log('未対応の診断名:', diagnosis);
      await client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '🐻‍❄️ 申し訳ございません。その診断は現在対応しておりません。' 
      });
      continue;
    }

    // ここから診断処理
    let user, partner, topic, question;
    
    if (diagnosis.includes('相性診断')) {
      const data = extractMatchData(input);
      if (!data) {
        await client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '入力に不備があります。もう一度お試しくださいm(_ _)m' 
        });
        continue;
      }
      user = data.user;
      partner = data.partner;
      topic = data.topic;
    } else {
      const data = extractUserData(input);
      if (!data) {
        await client.replyMessage(event.replyToken, { 
          type: 'text', 
          text: '入力に不備があります。もう一度お試しくださいm(_ _)m' 
        });
        continue;
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
        throw new Error('プロンプトファイルが見つかりません: ' + promptFilePath);
      }
      
      const promptData = JSON.parse(fs.readFileSync(promptFilePath, 'utf8'));
      
      // プロンプトファイルの構造に合わせて変数を構築
      const vars = {
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
        question: question || topic || '―',
        topic: topic || '―'
      };

      console.log('作成された変数:', JSON.stringify(vars, null, 2));

      // プロンプトファイルのsummaryBlockTemplateを使用してサマリーを作成
      let summary;
      if (diagnosis.includes('相性診断')) {
        summary = '◆ あなた：' + user.mbti + '/' + user.gender + '/' + user.year + '年' + user.month + '月' + user.day + '日 動物：' + userAttr.animal + ' 算命：' + userAttr.stem + '（' + userAttr.element + '/' + userAttr.guardian + '）\n◆ 相手：' + partner.mbti + '/' + partner.gender + '/' + partner.year + '年' + partner.month + '月' + partner.day + '日 動物：' + partnerAttr.animal + ' 算命：' + partnerAttr.stem + '（' + partnerAttr.element + '/' + partnerAttr.guardian + '）\n◆ 関係性：' + topic;
      } else {
        summary = promptData.summaryBlockTemplate ? 
          replaceVars(promptData.summaryBlockTemplate, vars) :
          '◆ MBTI：' + user.mbti + '\n◆ 動物占い：' + userAttr.animal + '\n◆ 算命学：' + userAttr.stem + '（五行：' + userAttr.element + '／守護神：' + userAttr.guardian + '）\n◆ お悩み：' + (question || '―');
      }

      vars.summary = summary;

      // プロンプトを構築
      const prompt = promptData.extraInstruction + '\n\n' + 
                    replaceVars(promptData.structureGuide.join('\n'), vars) + 
                    '\n\n上記の指示に従って、すべてのセクションを含む完全な診断文を生成してください。アウトラインやガイドラインではなく、実際の診断文章を書いてください。';

      // OpenAI API呼び出し
      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: promptData.usePromptTemplate + '\nあなたは診断文を作成する専門家です。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.75,
        max_tokens: 4000,
        presence_penalty: 0.7,
        frequency_penalty: 0.4
      }, {
        headers: {
          Authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      });

      const advice = aiRes.data.choices[0].message.content;
      const filename = event.source.userId + '_' + Date.now() + '.pdf';
      const filepath = await generatePDF(
        titleMap[diagnosis] + '\n' + summary,
        advice, 
        filename, 
        path.join(__dirname, 'templates', 'shindan01-top.pdf'), 
        titleMap[diagnosis]
      );
      const fileUrl = await uploadPDF(filepath);

      await client.pushMessage(event.source.userId, [
        { 
          type: 'text', 
          text: '🐻‍❄️ ' + userName + 'さん、お待たせしました！\n診断結果のPDFが完成しました📄✨\n\nこちらからご確認ください：'
        },
        { type: 'text', text: fileUrl }
      ]);

    } catch (error) {
      const errorLog = {
        message: error.message,
        status: error.response ? error.response.status : undefined,
        statusText: error.response ? error.response.statusText : undefined,
        errorDetails: error.response && error.response.data ? error.response.data.error : undefined
      };
      console.error('Error processing diagnosis:', errorLog);
      
      await client.pushMessage(event.source.userId, [
        { type: 'text', text: '🐻‍❄️ 申し訳ございません。診断の処理中にエラーが発生しました。もう一度お試しください。' }
      ]);
    }
  }

  res.status(200).send('OK');
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', function() {
  console.log('✅ Server running on ' + port);
});

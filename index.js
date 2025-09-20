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
  '無料トータル診断': '◆◆ あなただけのトータル分析 ◆◆',
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
  let mbtiMatch = input.match(/MBTI[：:]\s*([A-Z]{4})/i);

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

/**
 * ${...} だけを置換対象にする。{...} はテンプレのダミー指示として残す。
 * 未定義はそのまま残す（空文字にしない）。
 */
function replaceVars(str, vars) {
  return str.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (match, key) => {
    console.log(`変数置換: ${key}`);
    const keys = key.split('.');
    let value = vars;
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) {
        console.log(`変数 ${key} が見つかりません。未展開のまま残します`);
        return match; // 未定義はプレースホルダを残す
      }
    }
    const result = String(value);
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

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.post('/webhook', middleware(config), async (req, res) => {
  // 署名検証はミドルウェアに委任（誤判定を避ける）
  // if (!validateSignature(req)) return res.status(403).send('Invalid signature');

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

    // ユーザーデータを抽出
    const userData = extractUserData(input);
    if (!userData) {
      await client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '入力に不備があります。もう一度お試しくださいm(_ _)m' 
      });
      continue;
    }

    await client.replyMessage(event.replyToken, { 
      type: 'text', 
      text: '🐻‍❄️ 分析を作成中です…' 
    });

    try {
      const profile = await client.getProfile(event.source.userId);
      const userName = profile.displayName;
      const userAttr = getAttributes(userData.year, userData.month, userData.day);

      // プロンプトファイルを読み込み
      const promptFilePath = path.join(__dirname, 'prompts', 'muryo_total.json');
      if (!fs.existsSync(promptFilePath)) {
        throw new Error(`プロンプトファイルが見つかりません: ${promptFilePath}`);
      }
      
      const promptData = JSON.parse(fs.readFileSync(promptFilePath, 'utf8'));
      
      // 変数を構築
      const vars = {
        user: {
          mbti: userData.mbti,
          year: userData.year,
          month: userData.month,
          day: userData.day,
          gender: userData.gender || null
        },
        attrs: {
          animal: userAttr.animal,
          stem: userAttr.stem,
          element: userAttr.element,
          guardian: userAttr.guardian
        },
        question: userData.question || '―'
      };

      console.log('作成された変数:', JSON.stringify(vars, null, 2));

      // サマリーを作成
      const summary = promptData.summaryBlockTemplate ? 
        replaceVars(promptData.summaryBlockTemplate, vars) :
        `◆ MBTI：${userData.mbti}\n◆ 動物占い：${userAttr.animal}\n◆ 算命学：${userAttr.stem}（五行：${userAttr.element}／守護神：${userAttr.guardian}）\n◆ お悩み：${userData.question || '―'}`;

      vars.summary = summary;

      // プロンプトを構築（usePromptTemplate / extraInstruction / structureGuide すべてに展開適用）
      const useTpl = replaceVars(promptData.usePromptTemplate || '', vars);
      const extra  = replaceVars(promptData.extraInstruction || '', vars);
      const struct = replaceVars((promptData.structureGuide || []).join('\n'), vars);
      const prompt = `${useTpl}\n\n${extra}\n\n${struct}`;

      // OpenAI API呼び出し
      try {
        console.log('=== API呼び出し開始 ===');
        console.log('プロンプト長:', prompt.length);
        console.log('プロンプトの先頭500文字:', prompt.substring(0, 500));
        console.log('API KEY存在:', !!process.env.OPENAI_API_KEY);
        console.log('API KEY先頭10文字:', process.env.OPENAI_API_KEY?.substring(0, 10));
        
        const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                'この出力は娯楽・自己省察用の一般情報であり、医療・心理・法務・投資などの専門的助言や診断ではありません。' +
                '健康・メンタルヘルス・危機対応は扱わず、危険・有害な行為を助長しないでください。' +
                '優しいトーンで、ユーザーの尊厳を尊重し、具体例は日常の範囲に限定してください。'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0.6,
          max_tokens: 4000
        }, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        });

        console.log('=== API成功 ===');
        console.log('レスポンスの先頭200文字:', aiRes.data.choices[0].message.content.substring(0, 200));
        
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
          { type: 'text', text: `🐻‍❄️ ${userName}さん、お待たせしました！\n分析結果のPDFが完成しました📄✨\n\nこちらからご確認ください：` },
          { type: 'text', text: fileUrl }
        ]);

      } catch (apiError) {
        console.error('=== OpenAI APIエラー詳細 ===');
        console.error('ステータス:', apiError.response?.status);
        console.error('エラーデータ:', JSON.stringify(apiError.response?.data, null, 2));
        console.error('メッセージ:', apiError.message);
        
        await client.pushMessage(event.source.userId, [
          { type: 'text', text: `🐻‍❄️ APIエラーが発生しました。\nエラー: ${apiError.response?.data?.error?.message || apiError.message}` }
        ]);
        continue;
      }

    } catch (error) {
      console.error('Error processing diagnosis:', error);
      await client.pushMessage(event.source.userId, [
        { type: 'text', text: '🐻‍❄️ 申し訳ございません。分析の処理中にエラーが発生しました。もう一度お試しください。' }
      ]);
    }
  }

  res.status(200).send('OK');
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`✅ Server running on ${port}`));

require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new Client(config);

// JSONファイル読み込み
const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json'), 'utf-8'));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json'), 'utf-8'));

// 干支番号計算：基準日を1986/2/4に修正
function getCorrectEtoIndex(year, month, day) {
  const baseDate = new Date(1986, 1, 4); // 月は0始まり
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  return ((diffDays % 60 + 60) % 60) + 1;
}

// 日干を算出する関数
function getDayStem(year, month, day) {
  const baseDate = new Date(1873, 0, 12); // 1873年1月12日「甲子」
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const tenStems = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  return tenStems[(diffDays % 10 + 10) % 10];
}

// ▼ MBTIタイプごとの説明マップ（事前定義）
const mbtiDescriptions = {
  ENFP: '情熱的で自由を愛する冒険家タイプ',
  INFP: '内向的で理想を追い求めるロマンチスト',
  INFJ: '深い共感力と洞察力を持つ導き手',
  ENFJ: '人を育て導くカリスマリーダー',
  INTJ: '戦略家タイプ、未来を見据える思考家',
  ENTJ: '決断力に優れた生まれながらのリーダー',
  INTP: '理論派で好奇心旺盛な分析者',
  ENTP: '創造的でアイデア豊富な挑戦者',
  ISFP: '感性豊かで自由を愛するアーティスト',
  ESFP: '楽しく場を盛り上げるムードメーカー',
  ISTP: '冷静で現実的な職人タイプ',
  ESTP: '行動派で刺激を求める冒険者',
  ISFJ: '献身的で人を支える縁の下の力持ち',
  ESFJ: '人を思いやる協調型リーダー',
  ISTJ: '責任感が強く真面目な実務家',
  ESTJ: '秩序を重んじるしっかり者の管理者'
};

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('No events');

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userInput = event.message.text;
    const dateRegex = /(\d{4})年?(\d{1,2})月?(\d{1,2})日?/;
    const mbtiRegex = /\b(INFP|ENFP|INFJ|ENFJ|INTP|ENTP|INTJ|ENTJ|ISFP|ESFP|ISTP|ESTP|ISFJ|ESFJ|ISTJ|ESTJ)\b/i;

    const dateMatch = userInput.match(dateRegex);
    const mbtiMatch = userInput.match(mbtiRegex);

    if (!dateMatch || !mbtiMatch) {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '生年月日（例：1996年4月24日）とMBTI（例：ENFP）を一緒に送ってね！'
      });
      continue;
    }

    const year = parseInt(dateMatch[1]);
    const month = parseInt(dateMatch[2]);
    const day = parseInt(dateMatch[3]);
    const mbti = mbtiMatch[0].toUpperCase();

    const zodiacNumber = getCorrectEtoIndex(year, month, day);
    console.log(`干支番号: ${zodiacNumber}`);

    const animalEntry = animalMap.find(entry => parseInt(entry.干支番号) === zodiacNumber);
    const animalType = animalEntry?.動物 || '不明';
    const animalDescription = animalEntry
      ? `「${animalEntry.動物}」タイプは、${animalEntry.リズム}のリズムを持ち、カラーは${animalEntry.カラー}です。`
      : '説明が見つかりません。';

    const dayStem = getDayStem(year, month, day); // ← 修正済み
    const stemData = stemMap.find(entry => entry.day_stem === dayStem);
    const element = stemData?.element || '不明';
    const guardianSpirit = stemData?.guardian_spirit || '不明';
    const stemDescription = stemData?.description || '説明が見つかりません。';

    if (animalType === '不明' || element === '不明' || guardianSpirit === '不明') {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '診断情報が正しく取得できませんでした。別の生年月日で試してみてね！'
      });
      continue;
    }

    const prompt = `
こんにちは、白くまだよ☃️
この診断は「自分を知って、自分をもっと好きになる」ための“あなただけの取扱説明書”だよ。

🧸 あなたの分類と特徴まとめ
--------------------------
📘 MBTI：${mbti}
→ ${mbtiOneLiner}

🌟 動物占い：${animalType}
→ ${animalDescription}

🌿 算命学（日干）：${dayStem}
→ 五行：${element}｜守護神：${guardianSpirit}
→ ${stemDescription}

📩 ▼ アドバイスしてほしいこと：
- ${animalType}タイプの特徴（端的に）
- ${mbti}の傾向
- 五行「${element}」×守護神「${guardianSpirit}」の性質
- 見やすく、やさしく、女性向けに構成
-３つの診断を掛け合わせて俯瞰してみたときに、生まれ持った性質と今の性格を掛け合わせ、どんなズレがありそうで、それをどう解決したらいいかを優しく書いて
- 最後に、しろくまの言葉で前向きに締めて！

※文字数は800文字以内で、わかりやすく簡潔にお願いします。`
`;

    try {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'あなたは親しみやすい自己分析ガイドである白くまです。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 1200
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const reply = response.data.choices[0].message.content;
      const chunks = reply.match(/(.|[\r\n]){1,1500}/g).slice(0, 5);
      const messages = chunks.map(chunk => ({
        type: 'text',
        text: chunk
      }));

      await client.replyMessage(event.replyToken, messages);
    } catch (error) {
      console.error('OpenAI API error:', JSON.stringify(error.response?.data || error.message, null, 2));
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '診断中にエラーが発生しました。もう一度試してみてね！'
      });
    }
  }

  res.status(200).send('OK');
});

app.listen(3000, () => console.log('✅ Server is running on port 3000'));

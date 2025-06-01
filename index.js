const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

// LINE設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new Client(config);

// JSONデータの読み込み
const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json'), 'utf-8'));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json'), 'utf-8'));

// 干支番号（1~60）を生年月日から算出
function getEtoNumberFromDate(year, month, day) {
  const baseDate = new Date(1984, 1, 2); // 甲子日
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const etoNumber = ((diffDays % 60 + 60) % 60) + 1;
  return etoNumber;
}

// 日干を算出する（簡易ロジック、後で本実装へ置換）
function getDayStemFromEtoNumber(etoNumber) {
  const stems = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  return stems[(etoNumber - 1) % 10];
}

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events || [];

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
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
        return;
      }

      const [_, year, month, day] = dateMatch.map(Number);
      const mbti = mbtiMatch[0].toUpperCase();

      const etoNumber = getEtoNumberFromDate(year, month, day);
      const animalEntry = animalMap.find(entry => entry.干支番号 === etoNumber);
      const animalType = animalEntry?.動物 || '不明';
      const rhythm = animalEntry?.リズム || '不明';
      const color = animalEntry?.カラー || '不明';

      const dayStem = getDayStemFromEtoNumber(etoNumber);
      const stemEntry = stemMap.find(entry => entry.day_stem === dayStem);
      const element = stemEntry?.element || '不明';
      const guardian = stemEntry?.guardian_spirit || '不明';
      const stemDesc = stemEntry?.description || '説明なし';

      const prompt = `
こんにちは、白くまだよ。
以下の情報をもとに、自己分析アドバイスを出してください。

【本質：${animalType}】
→ 「${animalType}」タイプは、${rhythm}のリズムを持ち、カラーは${color}です。

【MBTIタイプ：${mbti}】

【算命学】
日干：${dayStem}
五行：${element}
守護神：${guardian}
説明：${stemDesc}

--- 
以下を600文字以内でアドバイスしてください：
- 動物占い「${animalType}」の特徴
- MBTI「${mbti}」の傾向
- 五行「${element}」と守護神「${guardian}」の性質

形式は：1. 共感 → 2. ズレの指摘 → 3. 解決策 → 4. まとめ
温かい語り口で。
`;

      try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'あなたは親しみやすい自己分析ガイドの白くまです。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.8,
          max_tokens: 1000
        }, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const reply = response.data.choices[0].message.content;
        const chunks = reply.match(/.{1,1800}/g) || [];

        const messages = chunks.map(text => ({ type: 'text', text }));
        await client.replyMessage(event.replyToken, messages);

      } catch (err) {
        console.error('OpenAI API Error:', err.response?.data || err.message);
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '診断中にエラーが発生しました。もう一度試してみてね！'
        });
      }
    }
  }

  res.status(200).send('OK');
});

app.listen(3000, () => console.log('Server is running'));

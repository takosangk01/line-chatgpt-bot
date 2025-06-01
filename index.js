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

// 🐾 干支番号算出（1996/4/24 → 干支番号53に合わせる）
function getEtoIndex(year, month, day) {
  const baseDate = new Date(1983, 11, 6); // ← 1983年12月6日を新しい基準日に設定
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  return ((diffDays % 60 + 60) % 60) + 1;
}

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

    const zodiacNumber = getEtoIndex(year, month, day);
    const animalEntry = animalMap.find(entry => entry.干支番号 === zodiacNumber);
    const animalType = animalEntry?.動物 || '不明';
    const animalDescription = animalEntry
      ? `「${animalEntry.動物}」タイプは、${animalEntry.リズム}のリズムを持ち、カラーは${animalEntry.カラー}です。`
      : '説明が見つかりません。';

    const dayStem = '丙'; // 今後は日干を自動算出予定
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

    const prompt = `こんにちは、白くまだよ。以下の情報をもとに、自己分析アドバイスを出してください。
【本質：${animalType}】
→ ${animalDescription}
【MBTIタイプ：${mbti}】
【算命学】
日干：${dayStem}
五行：${element}
守護神：${guardianSpirit}
説明：${stemDescription}
---
以下を600文字以内でアドバイスしてください：
- 動物占い「${animalType}」の特徴
- MBTI「${mbti}」の傾向
- 五行「${element}」と守護神「${guardianSpirit}」の性質
形式は：1. 共感 → 2. ズレの指摘 → 3. 解決策 → 4. まとめ
語り口は温かく、白くまが語るように。`;

    console.log("==== PROMPT ====");
    console.log(prompt);
    console.log("Prompt length:", prompt.length);

    try {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'あなたは親しみやすい自己分析ガイドである白くまです。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 600
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const reply = response.data.choices[0].message.content;
      const chunks = reply.match(/.{1,1800}/g);
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

app.listen(3000, () => console.log('Server is running'));

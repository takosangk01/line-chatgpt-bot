require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generatePDF } = require('./pdfGenerator');
const { uploadPDF } = require('./uploader');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new Client(config);

const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json'), 'utf-8'));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json'), 'utf-8'));

function getCorrectEtoIndex(year, month, day) {
  const baseDate = new Date(1986, 1, 4);
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  return ((diffDays % 60 + 60) % 60) + 1;
}

function getDayStem(year, month, day) {
  const baseDate = new Date(1873, 0, 12);
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const tenStems = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  return tenStems[(diffDays % 10 + 10) % 10];
}

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('No events');

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userInput = event.message.text;
    const dateRegex = /(\\d{4})年?(\\d{1,2})月?(\\d{1,2})日?/;
    const mbtiRegex = /\\b(INFP|ENFP|INFJ|ENFJ|INTP|ENTP|INTJ|ENTJ|ISFP|ESFP|ISTP|ESTP|ISFJ|ESFJ|ISTJ|ESTJ)\\b/i;

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
    const animalEntry = animalMap.find(entry => parseInt(entry.干支番号) === zodiacNumber);
    const animalType = animalEntry?.動物 || '不明';

    const dayStem = getDayStem(year, month, day);
    const stemData = stemMap.find(entry => entry.day_stem === dayStem);
    const element = stemData?.element || '不明';
    const guardianSpirit = stemData?.guardian_spirit || '不明';

    const summaryBlock = `MBTI：${mbti}\\n動物占い：${animalType}\\n算命学：${dayStem}（五行：${element}／守護神：${guardianSpirit}）`;

    const prompt = `${summaryBlock}\\nこの内容をもとに女性向けにやさしくPDF形式のアドバイス文を800文字以内で作成してください。`;

    try {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1500
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const advice = response.data.choices[0].message.content;
      const filename = `${event.source.userId}_${Date.now()}.pdf`;
      const filepath = await generatePDF(summaryBlock, advice, filename);
      const fileUrl = await uploadPDF(filepath);

      await client.replyMessage(event.replyToken, [
        { type: 'text', text: '診断結果のPDFが完成したよ✨' },
        { type: 'text', text: fileUrl }
      ]);
    } catch (err) {
      console.error(err);
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'エラーが発生しちゃったみたい。もう一度試してみてね。'
      });
    }
  }

  res.status(200).send('OK');
});

app.listen(3000, () => console.log('✅ Server is running on port 3000'));

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

const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json')));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json')));

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
  const stems = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  return stems[(diffDays % 10 + 10) % 10];
}

function extractDiagnosisName(input) {
  const match = input.match(/《《《(.+?)》》》/);
  return match ? match[1] : null;
}

function extractPartnerAttributes(input) {
  const match = input.match(/・相手\s+(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})\s+(\S+)/);
  if (!match) return null;
  const [ , year, month, day, mbti, gender ] = match;
  return {
    year: parseInt(year),
    month: parseInt(month),
    day: parseInt(day),
    mbti,
    gender
  };
}

function extractUserAttributes(input) {
  const match = input.match(/・自分\s+(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})\s+(\S+)/);
  if (!match) return null;
  const [ , year, month, day, mbti, gender ] = match;
  return {
    year: parseInt(year),
    month: parseInt(month),
    day: parseInt(day),
    mbti,
    gender
  };
}

function extractTopic(input) {
  const match = input.match(/・二人の関係性\s*(.+)/);
  return match ? match[1].trim() : null;
}

function getPromptFilePath(name) {
  if (name.includes('無料トータル診断')) return path.join(__dirname, 'prompts', 'muryo_total.json');
  if (name.includes('自分診断')) return path.join(__dirname, 'prompts', 'premium_trial.json');
  if (name.includes('相性診断')) return path.join(__dirname, 'prompts', 'premium_match_trial.json');
  return null;
}

function getAttributes(year, month, day) {
  const zodiacNumber = getCorrectEtoIndex(year, month, day);
  const animal = animalMap.find(e => parseInt(e.干支番号) === zodiacNumber)?.動物 || '不明';
  const stem = getDayStem(year, month, day);
  const stemInfo = stemMap.find(e => e.day_stem === stem) || {};
  return {
    animal,
    stem,
    element: stemInfo.element || '不明',
    guardian: stemInfo.guardian_spirit || '不明'
  };
}

function getSummaryBlock(name, user, partner, topic) {
  if (name.includes('相性診断')) {
    return `◆ あなた：${user.mbti}／${user.gender}／${user.year}年${user.month}月${user.day}日\n` +
           `◆ 相手　：${partner.mbti}／${partner.gender}／${partner.year}年${partner.month}月${partner.day}日\n` +
           `◆ 診断内容：${topic}`;
  } else {
    const attrs = getAttributes(user.year, user.month, user.day);
    return `◆ MBTI：${user.mbti}\n◆ 動物占い：${attrs.animal}\n◆ 算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）`;
  }
}

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const input = event.message.text;
    const diagnosisName = extractDiagnosisName(input);
    const promptPath = getPromptFilePath(diagnosisName);
    if (!diagnosisName || !promptPath) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '診断名が認識できませんでした。' });
      continue;
    }

    const user = extractUserAttributes(input);
    const partner = diagnosisName.includes('相性診断') ? extractPartnerAttributes(input) : null;
    const topic = diagnosisName.includes('相性診断') ? extractTopic(input) : null;

    if (!user || (diagnosisName.includes('相性診断') && (!partner || !topic))) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '入力内容に不備があります。' });
      continue;
    }

    await client.replyMessage(event.replyToken, { type: 'text', text: '🐻‍❄️ 診断を作成中です… 少しお待ちください！' });

    (async () => {
      try {
        const profile = await client.getProfile(event.source.userId);
        const userName = profile.displayName;
        const summary = getSummaryBlock(diagnosisName, user, partner, topic);

        const promptJson = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
        const filledPrompt = promptJson.prompt
          .replace('{mbti}', user.mbti)
          .replace('{animalType}', getAttributes(user.year, user.month, user.day).animal)
          .replace('{stem}', getAttributes(user.year, user.month, user.day).stem)
          .replace('{element}', getAttributes(user.year, user.month, user.day).element)
          .replace('{guardian}', getAttributes(user.year, user.month, user.day).guardian)
          .replace('{question}', topic || '―')
          .replace('{tone}', promptJson.tone || '')
          .replace('{sample}', promptJson.sample || '')
          .replace('{summary}', summary)
          .replace('{closing}', promptJson.closing || '');

        const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [{ role: 'user', content: filledPrompt }],
          temperature: 0.7,
          max_tokens: 4000
        }, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const advice = aiRes.data.choices[0].message.content;
        const filename = `${event.source.userId}_${Date.now()}.pdf`;
        const filepath = await generatePDF(summary, advice, filename, path.join(__dirname, 'templates', 'shindan01-top.pdf'));
        const fileUrl = await uploadPDF(filepath);

        const messages = [
          {
            type: 'text',
            text: `🐻‍❄️ ${userName}さん、お待たせしました！\n診断結果のPDFが完成しました📄✨\n\n内容はこちらからご確認ください：`
          },
          {
            type: 'text',
            text: fileUrl
          }
        ];
        await client.pushMessage(event.source.userId, messages);
      } catch (err) {
        console.error('診断処理エラー:', err);
      }
    })();
  }

  res.status(200).send('OK');
});

app.listen(3000, () => {
  console.log('✅ Server is running on port 3000');
});

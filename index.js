require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const crypto = require('crypto');
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
  const match = input.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})/);
  const question = input.match(/・お悩み\s*(.+)/)?.[1]?.trim();
  if (!match) return null;
  const [, y, m, d, mbti] = match;
  return { year: +y, month: +m, day: +d, mbti, question };
}

function extractMatchData(input) {
  const u = input.match(/・自分\s+(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})\s+(\S+)/);
  const p = input.match(/・相手\s+(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})\s+(\S+)/);
  const topic = input.match(/・二人の関係性\s*(.+)/)?.[1]?.trim();
  if (!u || !p || !topic) return null;
  return {
    user: { year: +u[1], month: +u[2], day: +u[3], mbti: u[4], gender: u[5] },
    partner: { year: +p[1], month: +p[2], day: +p[3], mbti: p[4], gender: p[5] },
    topic
  };
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

function getPromptFilePath(name) {
  if (name.includes('無料トータル診断')) return 'muryo_total.json';
  if (name.includes('自分診断')) return 'premium_trial.json';
  if (name.includes('相性診断')) return 'premium_match_trial.json';
  if (name.includes('取扱説明書プレミアム')) return 'premium_manual.json';
  return null;
}

function replaceVars(str, vars) {
  return str.replace(/\$\{(.*?)\}/g, (_, key) => vars[key] || '').replace(/\{(.*?)\}/g, (_, key) => vars[key] || '');
}

app.post('/webhook', middleware(config), async (req, res) => {
  if (!validateSignature(req)) return res.status(403).send('Invalid signature');

  for (const event of req.body.events) {
    try { await axios.post(process.env.LSTEP_WEBHOOK_URL, { events: [event] }); } catch (e) {}
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const input = event.message.text;
    const diagnosis = extractDiagnosisName(input);
    const promptFile = getPromptFilePath(diagnosis);
    if (!diagnosis || !promptFile) return client.replyMessage(event.replyToken, { type: 'text', text: '診断名が不明です。' });

    let user, partner, topic, question;
    if (diagnosis.includes('相性診断')) {
      const data = extractMatchData(input);
      if (!data) return client.replyMessage(event.replyToken, { type: 'text', text: '入力に不備があります。' });
      ({ user, partner, topic } = data);
    } else {
      const data = extractUserData(input);
      if (!data) return client.replyMessage(event.replyToken, { type: 'text', text: '入力に不備があります。' });
      user = data; question = data.question;
    }

    await client.replyMessage(event.replyToken, { type: 'text', text: '🐻‍❄️ 診断を作成中です…' });

    const profile = await client.getProfile(event.source.userId);
    const userName = profile.displayName;
    const userAttr = getAttributes(user.year, user.month, user.day);
    const partnerAttr = partner ? getAttributes(partner.year, partner.month, partner.day) : {};

    const summary = diagnosis.includes('相性診断') ?
      `◆ あなた：${user.mbti}/${user.gender}/${user.year}年${user.month}月${user.day}日 動物：${userAttr.animal} 算命：${userAttr.stem}（${userAttr.element}/${userAttr.guardian}）\n◆ 相手：${partner.mbti}/${partner.gender}/${partner.year}年${partner.month}月${partner.day}日 動物：${partnerAttr.animal} 算命：${partnerAttr.stem}（${partnerAttr.element}/${partnerAttr.guardian}）\n◆ 関係性：${topic}`
      : `◆ MBTI：${user.mbti}\n◆ 動物占い：${userAttr.animal}\n◆ 算命学：${userAttr.stem}（五行：${userAttr.element}／守護神：${userAttr.guardian}）\n◆ お悩み：${question || '―'}`;

    const promptJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts', promptFile), 'utf8'));
    const vars = {
      ...user, ...userAttr,
      ...(partner || {}), ...partnerAttr,
      question: question || topic || '―',
      summary,
    };
    const prompt = `${promptJson.usePromptTemplate}\n\n${promptJson.extraInstruction}\n\n${replaceVars(promptJson.structureGuide.join('\n'), vars)}`;

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
    const filepath = await generatePDF(`${titleMap[diagnosis]}\n${summary}`, advice, filename, path.join(__dirname, 'templates', 'shindan01-top.pdf'), titleMap[diagnosis]);
    const fileUrl = await uploadPDF(filepath);

    await client.pushMessage(event.source.userId, [
      { type: 'text', text: `🐻‍❄️ ${userName}さん、お待たせしました！\n診断結果のPDFが完成しました📄✨\n\nこちらからご確認ください：` },
      { type: 'text', text: fileUrl }
    ]);
  }

  res.status(200).send('OK');
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`✅ Server running on ${port}`));

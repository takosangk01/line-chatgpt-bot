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

// データ読み込み
const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json')));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json')));

// 干支番号取得
function getCorrectEtoIndex(year, month, day) {
  const baseDate = new Date(1986, 1, 4);
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  return ((diffDays % 60 + 60) % 60) + 1;
}

// 日干取得
function getDayStem(year, month, day) {
  const baseDate = new Date(1873, 0, 12);
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const stems = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  return stems[(diffDays % 10 + 10) % 10];
}

// 属性取得
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

// 入力の診断名を抽出
function extractDiagnosisName(input) {
  const match = input.match(/《《《(.+?)》》》/);
  return match ? match[1] : null;
}

// 無料トータル診断の入力抽出
function extractSingleAttributes(input) {
  const match = input.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})/);
  if (!match) return null;
  const [ , year, month, day, mbti ] = match;
  return { year: parseInt(year), month: parseInt(month), day: parseInt(day), mbti };
}

// プレミアム自分診断の入力抽出
function extractPremiumAttributes(input) {
  const dateMbtiMatch = input.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})/);
  const questionMatch = input.match(/・お悩み\s*(.+)/);
  if (!dateMbtiMatch || !questionMatch) return null;
  const [ , year, month, day, mbti ] = dateMbtiMatch;
  return {
    year: parseInt(year),
    month: parseInt(month),
    day: parseInt(day),
    mbti,
    question: questionMatch[1].trim()
  };
}

// 相性診断の入力抽出
function extractUserPartnerTopic(input) {
  const userMatch = input.match(/・自分\s+(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})\s+(\S+)/);
  const partnerMatch = input.match(/・相手\s+(\d{4})年(\d{1,2})月(\d{1,2})日\s+([A-Z]{4})\s+(\S+)/);
  const topicMatch = input.match(/・二人の関係性\s*(.+)/);
  if (!userMatch || !partnerMatch || !topicMatch) return null;
  return {
    user: {
      year: parseInt(userMatch[1]),
      month: parseInt(userMatch[2]),
      day: parseInt(userMatch[3]),
      mbti: userMatch[4],
      gender: userMatch[5]
    },
    partner: {
      year: parseInt(partnerMatch[1]),
      month: parseInt(partnerMatch[2]),
      day: parseInt(partnerMatch[3]),
      mbti: partnerMatch[4],
      gender: partnerMatch[5]
    },
    topic: topicMatch[1].trim()
  };
}

// 診断名ごとのプロンプトファイルパス
function getPromptFilePath(name) {
  if (name.includes('無料トータル診断')) return path.join(__dirname, 'prompts', 'muryo_total.json');
  if (name.includes('自分診断')) return path.join(__dirname, 'prompts', 'premium_trial.json');
  if (name.includes('相性診断')) return path.join(__dirname, 'prompts', 'premium_match_trial.json');
  return null;
}

// Webhookエンドポイント
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

    let user, partner, topic, question;
    if (diagnosisName.includes('無料トータル診断')) {
      user = extractSingleAttributes(input);
    } else if (diagnosisName.includes('自分診断')) {
      const data = extractPremiumAttributes(input);
      if (data) {
        user = data;
        question = data.question;
      }
    } else if (diagnosisName.includes('相性診断')) {
      const data = extractUserPartnerTopic(input);
      if (data) {
        user = data.user;
        partner = data.partner;
        topic = data.topic;
      }
    }

    if (!user || (diagnosisName.includes('相性診断') && (!partner || !topic))) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '入力内容に不備があります。' });
      continue;
    }

    await client.replyMessage(event.replyToken, { type: 'text', text: '🐻‍❄️ 診断を作成中です… 少しお待ちください！' });

    (async () => {
      try {
        const profile = await client.getProfile(event.source.userId);
        const userName = profile.displayName;
        const attrs = getAttributes(user.year, user.month, user.day);

        let summaryTitle = '◆◆ あなただけのトータル診断 ◆◆';
        if (diagnosisName.includes('相性診断')) summaryTitle = '◆◆ ふたりの相性診断 ◆◆';
        if (diagnosisName.includes('自分診断')) summaryTitle = '◆◆ あなただけのプレミアム診断 ◆◆';

        let summary = '';
        if (diagnosisName.includes('相性診断')) {
          const partnerAttrs = getAttributes(partner.year, partner.month, partner.day);
          summary =
            `◆ あなた：${user.mbti}／${user.gender}／${user.year}年${user.month}月${user.day}日／動物占い：${attrs.animal}／算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）\n` +
            `◆ 相手　：${partner.mbti}／${partner.gender}／${partner.year}年${partner.month}月${partner.day}日／動物占い：${partnerAttrs.animal}／算命学：${partnerAttrs.stem}（五行：${partnerAttrs.element}／守護神：${partnerAttrs.guardian}）\n` +
            `◆ 診断内容：${topic}`;
        } else if (diagnosisName.includes('自分診断')) {
          summary =
            `◆ MBTI：${user.mbti}\n` +
            `◆ 動物占い：${attrs.animal}\n` +
            `◆ 算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）\n` +
            `◆ お悩み：${question || '―'}`;
        } else {
          summary =
            `◆ MBTI：${user.mbti}\n` +
            `◆ 動物占い：${attrs.animal}\n` +
            `◆ 算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）`;
        }

        const fullSummary = `${summaryTitle}\n${summary}`;
        const promptJson = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
        const promptText =
          `${promptJson.usePromptTemplate || ''}\n\n${promptJson.extraInstruction || ''}\n\n${promptJson.structureGuide?.join('\n') || ''}\n\n${promptJson.tone ? `口調：${promptJson.tone}` : ''}\n\n---\n\n${promptJson.summaryBlockTemplate || ''}`
            .replace(/\$\{user\.mbti\}/g, user.mbti)
            .replace(/\$\{attrs\.animal\}/g, attrs.animal)
            .replace(/\$\{attrs\.stem\}/g, attrs.stem)
            .replace(/\$\{attrs\.element\}/g, attrs.element)
            .replace(/\$\{attrs\.guardian\}/g, attrs.guardian)
            .replace(/\{question\}/g, question || topic || '―')
            .replace(/\{summary\}/g, fullSummary);

        const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [{ role: 'user', content: promptText }],
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
        const filepath = await generatePDF(fullSummary, advice, filename, path.join(__dirname, 'templates', 'shindan01-top.pdf'));
        const fileUrl = await uploadPDF(filepath);

        await client.pushMessage(event.source.userId, [
          { type: 'text', text: `🐻‍❄️ ${userName}さん、お待たせしました！\n診断結果のPDFが完成しました📄✨\n\nこちらからご確認ください：` },
          { type: 'text', text: fileUrl }
        ]);
      } catch (err) {
        console.error('診断処理エラー:', err);
      }
    })();
  }

  res.status(200).send('OK');
});

// ✅ ポート自動対応（Render用）
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server is running on port ${port}`);
});

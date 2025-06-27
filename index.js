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

function extractDateAndMBTI(input) {
  const normalized = input.replace(/[／\/]/g, '年').replace(/[月.]/g, '月').replace(/[日\s]/g, '日')
                          .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
  const dateRegex = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
  const mbtiRegex = /\b(INFP|ENFP|INFJ|ENFJ|INTP|ENTP|INTJ|ENTJ|ISFP|ESFP|ISTP|ESTP|ISFJ|ESFJ|ISTJ|ESTJ)\b/i;

  const dateMatch = normalized.match(dateRegex);
  const mbtiMatch = input.match(mbtiRegex);

  if (dateMatch && mbtiMatch) {
    return {
      year: parseInt(dateMatch[1]),
      month: parseInt(dateMatch[2]),
      day: parseInt(dateMatch[3]),
      mbti: mbtiMatch[0].toUpperCase()
    };
  }
  return null;
}

function extractDiagnosisName(input) {
  const match = input.match(/《《《(.+?)》》》/);
  return match ? match[1] : null;
}

function getPromptFilePath(diagnosisName) {
  if (diagnosisName.includes('無料トータル診断')) {
    return path.join(__dirname, 'prompts', 'muryo_total.json');
  } else if (diagnosisName.includes('相性診断')) {
    return path.join(__dirname, 'prompts', 'premium_match_trial.json');
  } else if (diagnosisName.includes('自分診断')) {
    return path.join(__dirname, 'prompts', 'premium_trial.json');
  } else {
    return null;
  }
}

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('No events');

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const input = event.message.text;
    const extracted = extractDateAndMBTI(input);
    const diagnosisName = extractDiagnosisName(input);
    const promptPath = getPromptFilePath(diagnosisName);

    if (!diagnosisName || !promptPath || !extracted) {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '診断名や生年月日・MBTIが正しく認識できませんでした。もう一度お試しください。'
      });
      continue;
    }

    let prompt;
    try {
      prompt = fs.readFileSync(promptPath, 'utf-8');
    } catch (err) {
      console.error('プロンプト読み込みエラー:', err);
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '診断用プロンプトの読み込みに失敗しました。運営にお問い合わせください。'
      });
      continue;
    }

    const { year, month, day, mbti } = extracted;
    const zodiacNumber = getCorrectEtoIndex(year, month, day);
    const animalEntry = animalMap.find(entry => parseInt(entry.干支番号) === zodiacNumber);
    const animalType = animalEntry?.動物 || '不明';

    const dayStem = getDayStem(year, month, day);
    const stemData = stemMap.find(entry => entry.day_stem === dayStem);
    const element = stemData?.element || '不明';
    const guardianSpirit = stemData?.guardian_spirit || '不明';

    if (animalType === '不明' || element === '不明' || guardianSpirit === '不明') {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '診断情報が取得できなかったよ。他の生年月日で試してみてね。'
      });
      continue;
    }

    const summaryBlock = `◆ MBTI：${mbti}\n◆ 動物占い：${animalType}\n◆ 算命学：${dayStem}（五行：${element}／守護神：${guardianSpirit}）`;

    const userId = event.source.userId;
    const profile = await client.getProfile(userId);
    const userName = profile.displayName;

    const fullPrompt = `
${prompt}

【診断結果まとめ】
${summaryBlock}`;

    try {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [{ role: 'user', content: fullPrompt }],
        temperature: 0.7,
        max_tokens: 5000
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const advice = response.data.choices[0].message.content;
      const filename = `${userId}_${Date.now()}.pdf`;

      const filepath = await generatePDF(
        summaryBlock,
        advice,
        filename,
        path.join(__dirname, 'templates', 'shindan01-top.pdf')
      );

      const fileUrl = await uploadPDF(filepath);

      await client.replyMessage(event.replyToken, [
        {
          type: 'text',
          text: `🐻‍❄️ ${userName}さん、お待たせしました！\nあなたの診断結果がまとまったPDFができました📄✨\n\n生年月日とMBTIから見えてきた、\n今の${userName}さんの「本質」や「今の流れ」をギュッと詰め込んでます。\n\n------\n\nまずは気になるところからでOK！\nピンとくる言葉が、きっと見つかるはず👇`
        },
        {
          type: 'text',
          text: fileUrl
        }
      ]);
    } catch (err) {
      console.error('Error:', err);
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'エラーが発生しちゃったみたい。もう一度試してみてね。'
      });
    }
  }

  res.status(200).send('OK');
});

app.listen(3000, () => console.log('✅ Server is running on port 3000'));

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

// 生年月日から干支番号を計算
function getCorrectEtoIndex(year, month, day) {
  const baseDate = new Date(1986, 1, 4);
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  return ((diffDays % 60 + 60) % 60) + 1;
}

// 日干を取得
function getDayStem(year, month, day) {
  const baseDate = new Date(1873, 0, 12);
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const tenStems = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  return tenStems[(diffDays % 10 + 10) % 10];
}

// メッセージから診断名を抽出
function extractDiagnosisName(input) {
  const match = input.match(/《《《(.+?)》》》/);
  return match ? match[1] : null;
}

// 診断名に応じたプロンプトファイルを取得
function getPromptFilePath(diagnosisName) {
  if (!diagnosisName) return null;

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

// 属性を取得する共通関数
function getAttributes(year, month, day, mbti) {
  const zodiacNumber = getCorrectEtoIndex(year, month, day);
  const animalEntry = animalMap.find(entry => parseInt(entry.干支番号) === zodiacNumber);
  const animalType = animalEntry?.動物 || '不明';

  const dayStem = getDayStem(year, month, day);
  const stemData = stemMap.find(entry => entry.day_stem === dayStem);
  const element = stemData?.element || '不明';
  const guardianSpirit = stemData?.guardian_spirit || '不明';

  return {
    mbti,
    dayStem,
    animalType,
    element,
    guardianSpirit
  };
}

// summaryBlockを作成
function getSummaryBlock(attrs) {
  return `◆ MBTI：${attrs.mbti}\n◆ 動物占い：${attrs.animalType}\n◆ 算命学：${attrs.dayStem}（五行：${attrs.element}／守護神：${attrs.guardianSpirit}）`;
}

// プレーンな日付とMBTIを抽出（1人用）
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

// 相性診断専用の2人分抽出
function extractPartnerInfo(input) {
  const lines = input.split('\n').map(l => l.trim());

  const selfDateLine = lines.find(line => line.startsWith('・自分')) || '';
  const partnerDateLine = lines.find(line => line.startsWith('・相手')) || '';
  const topicLine = lines.find(line => line.startsWith('・二人の関係性')) || '';

  const self = extractDateAndMBTI(selfDateLine);
  const partner = extractDateAndMBTI(partnerDateLine);
  const topic = topicLine.split('：')[1]?.trim();

  return { self, partner, topic };
}

// Webhookエントリーポイント
app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.status(200).send('No events');

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const input = event.message.text;
    const diagnosisName = extractDiagnosisName(input);
    const promptPath = getPromptFilePath(diagnosisName);

    if (!diagnosisName || !promptPath) {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '診断名が正しく認識できませんでした。もう一度お試しください。'
      });
      continue;
    }

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: '🐻‍❄️ 診断を作成中です… 少しだけお待ちください！'
    });

    (async () => {
      try {
        const promptJson = JSON.parse(fs.readFileSync(promptPath, 'utf-8'));
        const userName = (await client.getProfile(event.source.userId)).displayName;

        let fullPrompt = '';
        let summaryBlock = '';

        if (diagnosisName.includes('相性診断')) {
          const { self, partner, topic } = extractPartnerInfo(input);
          if (!self || !partner || !topic) throw new Error('相性診断の入力不備');

          const selfAttr = getAttributes(self.year, self.month, self.day, self.mbti);
          const partnerAttr = getAttributes(partner.year, partner.month, partner.day, partner.mbti);

          summaryBlock = `◆ あなた：${selfAttr.mbti}／${selfAttr.dayStem}／${selfAttr.animalType}\n◆ 相手　：${partnerAttr.mbti}／${partnerAttr.dayStem}／${partnerAttr.animalType}\n◆ 診断内容：${topic}`;
          fullPrompt = promptJson.prompt
            .replace('{userMBTI}', selfAttr.mbti)
            .replace('{userGender}', '性別未設定')
            .replace('{userBirth}', `${self.year}/${self.month}/${self.day}`)
            .replace('{partnerMBTI}', partnerAttr.mbti)
            .replace('{partnerGender}', '性別未設定')
            .replace('{partnerBirth}', `${partner.year}/${partner.month}/${partner.day}`)
            .replace('{topic}', topic)
            .replace('{tone}', promptJson.tone)
            .replace('{sample}', promptJson.sample);

        } else {
          const extracted = extractDateAndMBTI(input);
          if (!extracted) throw new Error('自分診断の入力不備');

          const attr = getAttributes(extracted.year, extracted.month, extracted.day, extracted.mbti);
          summaryBlock = getSummaryBlock(attr);

          const question = input.split('\n').find(line => line.includes('相談')) || '相談内容未記載';

          fullPrompt = promptJson.prompt
            .replace('{mbti}', attr.mbti)
            .replace('{animalType}', attr.animalType)
            .replace('{stem}', attr.dayStem)
            .replace('{element}', attr.element)
            .replace('{guardian}', attr.guardianSpirit)
            .replace('{question}', question)
            .replace('{tone}', promptJson.tone)
            .replace('{sample}', promptJson.sample)
            .replace('{closing}', promptJson.closing);
        }

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [{ role: 'user', content: fullPrompt }],
          temperature: 0.7,
          max_tokens: 4000
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const advice = response.data.choices[0].message.content;
        const filename = `${event.source.userId}_${Date.now()}.pdf`;

        const filepath = await generatePDF(
          summaryBlock,
          advice,
          filename,
          path.join(__dirname, 'templates', 'shindan01-top.pdf')
        );

        const fileUrl = await uploadPDF(filepath);

        await client.pushMessage(event.source.userId, [
          { type: 'text', text: `🐻‍❄️ ${userName}さん、お待たせしました！\n\nPDF診断結果が完成しました📄✨` },
          { type: 'text', text: fileUrl }
        ]);

      } catch (err) {
        console.error('診断処理エラー:', err);
        await client.pushMessage(event.source.userId, {
          type: 'text',
          text: '診断の生成中にエラーが発生しました。もう一度お試しください。'
        });
      }
    })();
  }

  res.status(200).send('OK');
});

app.listen(3000, () => console.log('✅ Server is running on port 3000'));

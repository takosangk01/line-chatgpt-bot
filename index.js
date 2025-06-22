require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { generatePDF } = require('./pdfGenerator');
const { uploadPDF } = require('./uploader');

const app = express();
app.use(express.json());

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new Client(config);

const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json'), 'utf-8'));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json'), 'utf-8'));
const shirokumaProfile = JSON.parse(fs.readFileSync(path.join(__dirname, 'shirokumaProfile.json'), 'utf-8'));

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

app.post('/webhook/form', async (req, res) => {
  try {
    const { line_user_id, birthdate, mbti, form_id } = req.body;
    const [year, month, day] = birthdate.split('-').map(Number);

    const zodiacNumber = getCorrectEtoIndex(year, month, day);
    const animalEntry = animalMap.find(entry => parseInt(entry.干支番号) === zodiacNumber);
    const animalType = animalEntry?.動物 || '不明';

    const dayStem = getDayStem(year, month, day);
    const stemData = stemMap.find(entry => entry.day_stem === dayStem);
    const element = stemData?.element || '不明';
    const guardianSpirit = stemData?.guardian_spirit || '不明';

    if (animalType === '不明' || element === '不明' || guardianSpirit === '不明') {
      await client.pushMessage(line_user_id, {
        type: 'text',
        text: '診断情報が取得できなかったよ。他の生年月日で試してみてね。'
      });
      return res.status(200).send('NG');
    }

    const summaryBlock = `◆ MBTI：${mbti}
◆ 動物占い：${animalType}
◆ 算命学：${dayStem}（五行：${element}／守護神：${guardianSpirit}）`;

    const profile = await client.getProfile(line_user_id);
    const userName = profile.displayName;

    const prompt = `
${shirokumaProfile.usePromptTemplate}

以下の条件に従って、PDF出力用の診断結果を8000文字以内でやさしく生成してください。

【診断結果まとめ】
${summaryBlock}

【構成指示】
- MBTI/ 動物占い/ 算命学の３つの診断自体と診断結果のそれぞれの特徴を出して！
- この３つの観点から考えて、どんなギャップがあるのか、またどんな課題や問題が起こる可能性があり、どのように解決をするべきなのか
- 年度によっての運気の流れと性格を見て、中期的にどのように行動をするべきなのか
- まとめの文章を2000文字以上の長文で書いてユーザーの満足度を担保して！（${shirokumaProfile.closing} のトーンを参考に）
- 文章内容は${shirokumaProfile.sample} の参考文章を参考に
- 絵文字は出力エラーになるから絵文字は使わず、段落や見出しは記号などを使ってわかりやすくして

【文章のトーン】
${shirokumaProfile.tone}
`;

    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 5000
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const advice = response.data.choices[0].message.content;
    const filename = `${line_user_id}_${Date.now()}.pdf`;

    const filepath = await generatePDF(
      summaryBlock,
      advice,
      filename,
      path.join(__dirname, 'templates', 'shindan01-top.pdf')
    );

    const fileUrl = await uploadPDF(filepath);

    await client.pushMessage(line_user_id, [
      {
        type: 'text',
        text: `🐻‍❄️ ${userName}さん、お待たせしました！
あなたの診断結果がまとまったPDFができました📄✨

生年月日とMBTIから見えてきた、
今の${userName}さんの「本質」や「今の流れ」をギュッと詰め込んでます。

------

まずは気になるところからでOK！
ピンとくる言葉が、きっと見つかるはず👇`
      },
      {
        type: 'text',
        text: fileUrl
      }
    ]);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error:', err);
    res.status(500).send('Server error');
  }
});


app.listen(3000, () => console.log('✅ Server is running on port 3000'));

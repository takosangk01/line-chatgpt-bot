require('dotenv').config();
const express = require('express');
const { Client } = require('@line/bot-sdk');
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

// データ読み込み
const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json'), 'utf-8'));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json'), 'utf-8'));

// 干支番号（60周期）
function getCorrectEtoIndex(year, month, day) {
  const baseDate = new Date(1986, 1, 4); // 1986年2月4日
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  return ((diffDays % 60 + 60) % 60) + 1;
}

// 日干（十干）
function getDayStem(year, month, day) {
  const baseDate = new Date(1873, 0, 12); // 明治6年1月12日（西暦開始日）
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const tenStems = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
  return tenStems[(diffDays % 10 + 10) % 10];
}

app.post('/webhook/form', async (req, res) => {
  try {
    const { line_user_id, birthdate, mbti, form_id } = req.body;
    const [year, month, day] = birthdate.split('-').map(Number);

    const templatePath = path.join(__dirname, 'form_templates', `${form_id}.json`);
    if (!fs.existsSync(templatePath)) {
      await client.pushMessage(line_user_id, {
        type: 'text',
        text: '指定されたフォームのテンプレートが見つかりませんでした。'
      });
      return res.status(400).send('Template not found');
    }

    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));

    const zodiacNumber = getCorrectEtoIndex(year, month, day);
    const animalEntry = animalMap.find(entry => parseInt(entry.干支番号) === zodiacNumber);
    const animalType = animalEntry?.動物 || '不明';

    const dayStem = getDayStem(year, month, day);
    const stemData = stemMap.find(entry => entry.day_stem === dayStem);
    const element = stemData?.element || '不明';
    const guardianSpirit = stemData?.guardian_spirit || '不明';

    if ([animalType, element, guardianSpirit].includes('不明')) {
      await client.pushMessage(line_user_id, {
        type: 'text',
        text: '診断に必要な情報が取得できませんでした。別の生年月日で試してみてください。'
      });
      return res.status(200).send('NG');
    }

    const summaryBlock = template.summaryBlockTemplate
      .replace('{mbti}', mbti)
      .replace('{animalType}', animalType)
      .replace('{dayStem}', dayStem)
      .replace('{element}', element)
      .replace('{guardianSpirit}', guardianSpirit);

    const profile = await client.getProfile(line_user_id);
    const userName = profile.displayName;

    const prompt = [
      template.usePromptTemplate,
      template.extraInstruction,
      `\n【診断結果まとめ】\n${summaryBlock}`,
      '\n【構成指示】',
      ...template.structureGuide,
      '\n【文章のトーン】',
      template.tone
    ].join('\n');

    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
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

    const advice = aiResponse.data.choices[0].message.content;

    const filename = `${line_user_id}_${Date.now()}.pdf`;
    const filepath = await generatePDF(
      summaryBlock,
      advice,
      filename,
      path.join(__dirname, 'templates', 'shindan01-top.pdf')
    );
    const fileUrl = await uploadPDF(filepath);

    const messageText = template.message1.replaceAll('{userName}', userName);

    await client.pushMessage(line_user_id, [
      { type: 'text', text: messageText },
      { type: 'text', text: fileUrl }
    ]);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Error in /webhook/form:', err);
    res.status(500).send('Server error');
  }
});

app.listen(3000, () => {
  console.log('✅ Server is running on port 3000');
});

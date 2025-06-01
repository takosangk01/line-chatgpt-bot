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

// JSON読み込み
const animalMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'corrected_animal_map_60.json'), 'utf-8'));
const stemMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'sanmeigaku_day_stem_map_extended.json'), 'utf-8'));

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).send('No events');
  }

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

      const year = parseInt(dateMatch[1]);
      const month = parseInt(dateMatch[2]);
      const day = parseInt(dateMatch[3]);
      const mbti = mbtiMatch[0].toUpperCase();

      const cycleIndex = (year - 1924) % 60;
      const zodiacNumber = cycleIndex === 0 ? 60 : cycleIndex;
      const animalEntry = animalMap.find(entry => entry.干支番号 === zodiacNumber);
      const animalType = animalEntry?.動物 || '不明';
      const animalDescription = animalEntry
        ? `「${animalEntry.動物}」タイプは、${animalEntry.リズム}のリズムを持ち、カラーは${animalEntry.カラー}です。`
        : '説明が見つかりません。';

      const trimmedAnimalDesc = animalDescription.slice(0, 300);

      // ★日干（dayStem）を仮に設定 → 後ほど生年月日から正確に計算するロジックを追加予定
      const dayStem = '丙';
      const stemData = stemMap.find(entry => entry.day_stem === dayStem);
      const element = stemData?.element || '不明';
      const guardianSpirit = stemData?.guardian_spirit || '不明';
      const stemDescription = stemData?.description || '説明が見つかりません。';
      const trimmedStemDesc = stemDescription.slice(0, 300);

      const prompt = `
こんにちは、白くまだよ。
あなたの性格診断の結果だよ！

【動物占い：${animalType}】
${trimmedAnimalDesc}

【MBTI：${mbti}】
（MBTIの解釈はAIが補完）

【算命学】
日干：${dayStem}／五行：${element}／守護神：${guardianSpirit}
${trimmedStemDesc}

これら3つをもとに、以下の形式で800文字以内でアドバイスしてください：

1. 共感  
2. ズレの指摘  
3. 解決策と受容  
4. まとめ

温かい口調で書いてね！
      `;

      console.log('==== PROMPT LENGTH ====');
      console.log(prompt.length);
      console.log('==== PROMPT ====');
      console.log(prompt);

      try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'あなたは親しみやすい自己分析ガイドである白くまです。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.8
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        console.log('==== RESPONSE ====');
        console.log(response.data);

        const reply = response.data.choices[0].message.content;
        const chunks = reply.match(/.{1,1800}/g);
        const messages = chunks.map(chunk => ({
          type: 'text',
          text: chunk
        }));

        await client.replyMessage(event.replyToken, messages);
      } catch (error) {
        console.error('OpenAI API error:', error.response?.data || error.message);
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

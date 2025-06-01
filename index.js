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
      const animalType = animalMap[cycleIndex]?.name || '不明';
      const animalDescription = animalMap[cycleIndex]?.description || '説明が見つかりません。';

      const dayStem = '丙'; // 仮設定
      const stemData = stemMap.find(entry => entry.day_stem === dayStem);
      const element = stemData?.element || '不明';
      const guardianSpirit = stemData?.guardian_spirit || '不明';
      const stemDescription = stemData?.description || '説明が見つかりません。';

      const prompt = `\n🐻‍❄️こんにちは、白くまだよ。\nあなたの「自分取扱説明書」ができたから、ぜひじっくり読んでみてね。\n\n---\n\n🟠【あなたの本質：${animalType}】\n→ 生まれ持った性格や感性の傾向を表すよ。\n${animalDescription}（300文字以内で）\n\n---\n\n🟢【あなたの思考のくせ（MBTIタイプ：${mbti})】\n→ 物事の捉え方や意思決定の傾向が出てるよ。\n（MBTIごとの強みとクセを250文字以内で）\n\n---\n\n🔵【算命学から見た宿命と資質】\nあなたの命式は「${dayStem}」の日干、五行は「${element}」だよ。\n守護神は「${guardianSpirit}」で、以下のような資質を持っているよ。\n${stemDescription}（300文字以内で）\n\n---\n\n🧸【しろくまからのアドバイス】\n\n以下の3つをかけあわせて、\n「あなたらしい強み」「感じやすいズレやギャップ」「どう受け入れていけばいいか」\nを**具体的・実践的に600～800文字で**アドバイスしてください。\n\n- 動物占いの「${animalType}」の特徴\n- MBTIタイプ「${mbti}」の思考傾向\n- 五行「${element}」と守護神「${guardianSpirit}」の資質\n\n形式は、\n1. 共感 → 2. ズレの指摘 → 3. 解決策と受容 → 4. まとめ\nという4段構成で、必ず温かいトーンで書いてください。\n\n---\n\n📎 この診断は、動物占い・MBTI・算命学の3つを掛け合わせてつくった、あなたのためだけの1枚。\n\nいつでもこの白くまがそばにいると思って、迷ったときはまた戻ってきてね。`;

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

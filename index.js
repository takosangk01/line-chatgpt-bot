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

// 十干（天干）リスト
const tenStems = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

// 西暦から簡易的に日干（十干）を求める関数（正確ではなく仮運用向け）
function getDayStem(year, month, day) {
  const baseDate = new Date(1900, 0, 1); // 1900/1/1 = 甲子の日
  const targetDate = new Date(year, month - 1, day);
  const diffDays = Math.floor((targetDate - baseDate) / (1000 * 60 * 60 * 24));
  const stemIndex = diffDays % 10;
  return tenStems[(stemIndex + 10) % 10]; // 負の値対応
}

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

      // 干支番号（1924年=1）で取得（1〜60）
      let cycleIndex = (year - 1924) % 60;
      if (cycleIndex <= 0) cycleIndex += 60;
      const zodiacNumber = cycleIndex;
      const animalEntry = animalMap.find(entry => Number(entry.干支番号) === zodiacNumber);
      const animalType = animalEntry?.動物 || '不明';
      const animalDescription = animalEntry
        ? `「${animalEntry.動物}」タイプは、${animalEntry.リズム}のリズムを持ち、カラーは${animalEntry.カラー}です。`
        : '説明が見つかりません。';

      // 日干を算出
      const dayStem = getDayStem(year, month, day);
      const stemData = stemMap.find(entry => entry.day_stem === dayStem);
      const element = stemData?.element || '不明';
      const guardianSpirit = stemData?.guardian_spirit || '不明';
      const stemDescription = stemData?.description || '説明が見つかりません。';

      const prompt = `
🐻‍❄️こんにちは、白くまだよ。
あなたの「自分取扱説明書」ができたから、ぜひじっくり読んでみてね。

---

🟠【あなたの本質：${animalType}】
→ 生まれ持った性格や感性の傾向を表すよ。
${animalDescription}（300文字以内で）

---

🟢【あなたの思考のくせ（MBTIタイプ：${mbti})】
→ 物事の捉え方や意思決定の傾向が出てるよ。
（MBTIごとの強みとクセを250文字以内で）

---

🔵【算命学から見た宿命と資質】
あなたの命式は「${dayStem}」の日干、五行は「${element}」だよ。
守護神は「${guardianSpirit}」で、以下のような資質を持っているよ。
${stemDescription}（300文字以内で）

---

🧸【しろくまからのアドバイス】

以下の3つをかけあわせて、
「あなたらしい強み」「感じやすいズレやギャップ」「どう受け入れていけばいいか」
を**具体的・実践的に600～800文字で**アドバイスしてください。

- 動物占いの「${animalType}」の特徴
- MBTIタイプ「${mbti}」の思考傾向
- 五行「${element}」と守護神「${guardianSpirit}」の資質

形式は、
1. 共感 → 2. ズレの指摘 → 3. 解決策と受容 → 4. まとめ
という4段構成で、必ず温かいトーンで書いてください。

---

📎 この診断は、動物占い・MBTI・算命学の3つを掛け合わせてつくった、あなたのためだけの1枚。

いつでもこの白くまがそばにいると思って、迷ったときはまた戻ってきてね。
`;

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

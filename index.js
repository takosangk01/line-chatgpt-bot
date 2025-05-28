const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
const axios = require('axios');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new Client(config);

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userInput = event.message.text;

      // 生年月日とMBTIを抽出
      const dateRegex = /(\d{4})年?(\d{1,2})月?(\d{1,2})日?/;
      const mbtiRegex = /\b(INFP|ENFP|INFJ|ENFJ|INTP|ENTP|INTJ|ENTJ|ISFP|ESFP|ISTP|ESTP|ISFJ|ESFJ|ISTJ|ESTJ)\b/i;

      const dateMatch = userInput.match(dateRegex);
      const mbtiMatch = userInput.match(mbtiRegex);

      if (!dateMatch || !mbtiMatch) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '診断には「生年月日（例：1996年4月24日）」と「MBTI（例：ENFP）」の両方を入力してください。'
        });
        return;
      }

      const birthDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
      const mbti = mbtiMatch[0].toUpperCase();

      const prompt = `
あなたは性格診断の専門家AIです。

以下のユーザー情報をもとに、3つの診断軸（算命学／MBTI／進化版動物占い）を統合して、
その人が「どんな人物か」をキャラクター的に表現しながら、“自分取扱説明書”として使える情報を提供してください。

▼入力情報：
- 生年月日：${birthDate}
- MBTIタイプ：${mbti}

⚠️動物占いに関する条件：
- 必ず進化版動物占いの26種類（ペガサス、チーター、黒ひょう、たぬきなど）を使用すること
- 各キャラにカラー属性（オレンジ、グリーン、パープル、ブラック）を付ける
- 「本質」「表現」「意思決定」「理想」の4軸で記載
- 古い12動物・60分類などは使用禁止

⚠️算命学に関する条件：
- 五行（日干）を自然のイメージでキャラ化し、性格傾向を説明
- 命式展開は不要。要点を簡潔に

⚠️MBTIに関する条件：
- 認知スタイル・行動傾向・強みと弱みを具体的に解説
- 他2軸との整合性・ギャップにも言及

⚠️トーン：
- 親しみやすく、でも深みのある言葉で
- 自己紹介・SNS・日常で役立つ表現にする

▼出力構成：
1. 五行キャラ
2. 動物キャラ（本質・表現・意思決定・理想）
3. MBTIキャラ
4. キャラ統合まとめ
5. 自分取扱説明書（性格・付き合い方・やる気スイッチ・落ち込み時の対処法など）
`;

      try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'あなたは性格診断AIです。' },
            { role: 'user', content: prompt }
          ]
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const reply = response.data.choices[0].message.content;

        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: reply.length > 2000 ? reply.slice(0, 1997) + '…' : reply
        });
      } catch (error) {
        console.error('OpenAI API error:', error.response?.data || error.message);
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '診断中にエラーが発生しました。時間をおいてもう一度お試しください。'
        });
      }
    }
  }

  res.status(200).send('OK');
});

app.listen(3000, () => console.log('Server is running'));

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

  if (!events || events.length === 0) {
    return res.status(200).send('No events');
  }

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
あなたは「しろくま診断」の案内役です。  
20代女性に向けて、「占いより深く、自己分析よりあたたかい」癒しの診断体験を提供してください。  
キャラクター「しろくまさん」のように、やさしく話しかけるような言葉で、一人ひとりの気持ちに寄り添ってください。

---

▼ 入力情報：
- 生年月日：${birthDate}
- MBTIタイプ：${mbti}

---

▼ 使用する診断軸とルール：

① **算命学（五行）**  
- 日干から五行属性を算出（例：丙＝陽の火）  
- 自然物にたとえて、その人の気質や役割を表現すること（例：「たいまつのようにまわりを照らす人」）

② **動物占い（進化版）**  
- 本質／表現／意思決定／理想の4軸でキャラを出す  
- キャラ名は必ず固定（カラーは使わない）  
- 同じ生年月日なら毎回同じ結果になるようにすること

③ **MBTI**  
- タイプ名とあわせて、思考スタイル・対人傾向・迷いやすいポイントをやさしく解説すること  
- 他の軸（動物・五行）と関連づけてもよい

---

▼ 出力フォーマット：

🧸【しろくま診断だよ〜】

こんにちは、しろくまだよ。  
あなたの心の地図を見せてもらったよ。  
生年月日とMBTI、それに動物さんたちの力も借りて、やさしく言葉にしてみるね。

---

🌱【動物キャラから見たあなた】

・本質キャラ：〇〇  
・表現キャラ：〇〇  
・意思決定キャラ：〇〇  
・理想キャラ：〇〇

---

🔥【五行で見るあなたの気質】

あなたの五行は「〇〇（日干＋五行）」だよ。  
自然にたとえると「〇〇」みたいな存在。

---

🧠【MBTIからのメッセージ】

あなたのMBTIは「${mbti}」。  
あなたの思考スタイルや人との関わり方をやさしく紹介してあげて。

---

🧸【しろくまからのまとめ】

たくさんの面を見せてくれてありがとう。  
「だからこそ、あなたはあなたで素敵なんだよ」って、しろくまがぎゅっと抱きしめるように伝えてあげてね。

---

🛠【自分取扱説明書】

💖 自分のこと  
・大切にしたい3つのキーワード  
・しろくまが見た“いいところ”  
・ときどき出てくる“クセ”や“迷いぐせ”

🤝 他人と過ごすときのヒント  
・見られやすい印象と実際の自分とのギャップ  
・仲良くなるヒント  
・苦手なこと・地雷

🌿 気分が下がったときは…  
・落ち込みサイン  
・自分にかけてあげたい言葉  
・しろくまの処方せん：やさしいひとこと
`;

      try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'あなたは性格診断AIです。' },
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

        // LINEのメッセージは上限があるので分割して送信
        const chunks = reply.match(/.{1,1800}/g); // 安全圏で1800文字ずつ
        const messages = chunks.map(chunk => ({
          type: 'text',
          text: chunk
        }));

        await client.replyMessage(event.replyToken, messages);
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

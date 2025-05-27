
# LINE × ChatGPT 診断Bot

## 概要
このBotは、LINE公式アカウントを通じて受け取った「生年月日＋MBTI」の情報をChatGPT（OpenAI API）に送り、診断結果を返信します。

## セットアップ
1. 環境変数に以下を設定
- CHANNEL_ACCESS_TOKEN
- CHANNEL_SECRET
- OPENAI_API_KEY

2. `npm install` で依存をインストール  
3. `node index.js` で起動

## 使用技術
- Node.js
- Express
- LINE Messaging API
- OpenAI API

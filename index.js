// 上部の require と設定はそのまま

app.post('/webhook', middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const input = event.message.text;
    const diagnosisName = extractDiagnosisName(input);
    const promptPath = getPromptFilePath(diagnosisName);

    if (!diagnosisName || !promptPath) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '診断名が認識できませんでした。' });
      continue;
    }

    let user, partner, topic, question;
    if (diagnosisName.includes('無料トータル診断')) {
      user = extractSingleAttributes(input);
    } else if (diagnosisName.includes('自分診断')) {
      const data = extractPremiumAttributes(input);
      if (data) {
        user = data;
        question = data.question;
      }
    } else if (diagnosisName.includes('相性診断')) {
      const data = extractUserPartnerTopic(input);
      if (data) {
        user = data.user;
        partner = data.partner;
        topic = data.topic;
      }
    }

    if (!user || (diagnosisName.includes('相性診断') && (!partner || !topic))) {
      await client.replyMessage(event.replyToken, { type: 'text', text: '入力内容に不備があります。' });
      continue;
    }

    await client.replyMessage(event.replyToken, { type: 'text', text: '🐻‍❄️ 診断を作成中です… 少しお待ちください！' });

    (async () => {
      try {
        const profile = await client.getProfile(event.source.userId);
        const userName = profile.displayName;
        const attrs = getAttributes(user.year, user.month, user.day);

        let summaryTitle = '◆◆ あなただけのトータル診断 ◆◆';
        if (diagnosisName.includes('相性診断')) summaryTitle = '◆◆ ふたりの相性診断 ◆◆';
        if (diagnosisName.includes('自分診断')) summaryTitle = '◆◆ あなただけのプレミアム診断 ◆◆';

        let summary = '';
        if (diagnosisName.includes('相性診断')) {
          summary =
            `◆ あなた：${user.mbti}／${user.gender}／${user.year}年${user.month}月${user.day}日／動物占い：${attrs.animal}／算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）\n` +
            `◆ 相手　：${partner.mbti}／${partner.gender}／${partner.year}年${partner.month}月${partner.day}日／動物占い：${attrs.animal}／算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）\n` +
            `◆ 診断内容：${topic}`;
        } else if(diagnosisName.includes('自分診断')) {
          summary =
            `◆ MBTI：${user.mbti}\n` +
            `◆ 動物占い：${attrs.animal}\n` +
            `◆ 算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）\n` +
            `◆ お悩み：○○;
        }
          else {
          summary =
            `◆ MBTI：${user.mbti}\n` +
            `◆ 動物占い：${attrs.animal}\n` +
            `◆ 算命学：${attrs.stem}（五行：${attrs.element}／守護神：${attrs.guardian}）`;
        }

        const fullSummary = `${summaryTitle}\n${summary}`;

        const promptJson = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

        // プロンプトテンプレートをベースに置換
        const promptText = `${promptJson.usePromptTemplate || ''}\n\n${promptJson.extraInstruction || ''}\n\n${promptJson.structureGuide?.join('\n') || ''}\n\n${promptJson.tone ? `口調：${promptJson.tone}` : ''}\n\n---\n\n${promptJson.summaryBlockTemplate || ''}`
          .replace(/\$\{user\.mbti\}/g, user.mbti)
          .replace(/\$\{attrs\.animal\}/g, attrs.animal)
          .replace(/\$\{attrs\.stem\}/g, attrs.stem)
          .replace(/\$\{attrs\.element\}/g, attrs.element)
          .replace(/\$\{attrs\.guardian\}/g, attrs.guardian)
          .replace(/\{question\}/g, question || topic || '―')
          .replace(/\{summary\}/g, fullSummary);

        const aiRes = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4',
            messages: [{ role: 'user', content: promptText }],
            temperature: 0.7,
            max_tokens: 4000
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const advice = aiRes.data.choices[0].message.content;
        const filename = `${event.source.userId}_${Date.now()}.pdf`;
        const filepath = await generatePDF(fullSummary, advice, filename, path.join(__dirname, 'templates', 'shindan01-top.pdf'));
        const fileUrl = await uploadPDF(filepath);

        await client.pushMessage(event.source.userId, [
          { type: 'text', text: `🐻‍❄️ ${userName}さん、お待たせしました！\n診断結果のPDFが完成しました📄✨\n\nこちらからご確認ください：` },
          { type: 'text', text: fileUrl }
        ]);
      } catch (err) {
        console.error('診断処理エラー:', err);
      }
    })();
  }

  res.status(200).send('OK');
});

app.listen(3000, () => {
  console.log('✅ Server is running on port 3000');
});

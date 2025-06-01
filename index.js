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

// JSON�t�@�C���̓ǂݍ���
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

      const dateRegex = /(<<year\d{4})�N?(\d{1,2})��?(\d{1,2})��?/;
      const mbtiRegex = /\b(INFP|ENFP|INFJ|ENFJ|INTP|ENTP|INTJ|ENTJ|ISFP|ESFP|ISTP|ESTP|ISFJ|ESFJ|ISTJ|ESTJ)\b/i;

      const dateMatch = userInput.match(dateRegex);
      const mbtiMatch = userInput.match(mbtiRegex);

      if (!dateMatch || !mbtiMatch) {
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '���N�����i��F1996�N4��24���j��MBTI�i��FENFP�j���ꏏ�ɑ����ĂˁI'
        });
        return;
      }

      const year = parseInt(dateMatch[1]);
      const month = parseInt(dateMatch[2]);
      const day = parseInt(dateMatch[3]);
      const birthDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const mbti = mbtiMatch[0].toUpperCase();

      // ���x�ԍ����瓮���^�C�v�擾
      const baseYear = 1924;
      const cycleIndex = (year - baseYear) % 60;
      const animalType = animalMap[cycleIndex]?.name || '�s��';
      const animalDescription = animalMap[cycleIndex]?.description || '������������܂���B';

      // �������ݒ�i�����Z�o���W�b�N�ɒu���j
      const dayStem = '��';
      const stemData = stemMap.find(entry => entry.day_stem === dayStem);
      const element = stemData?.element || '�s��';
      const guardianSpirit = stemData?.guardian_spirit || '�s��';
      const stemDescription = stemData?.description || '������������܂���B';

      const prompt = `
???����ɂ��́A�����܂���B
���Ȃ��́u�����戵�������v���ł�������A���Ђ�������ǂ�ł݂ĂˁB

---

?�y���Ȃ��̖{���F${animalType}�z
�� ���܂ꎝ�������i�⊴���̌X����\����B
${animalDescription}�i300�����ȓ��Łj

---

?�y���Ȃ��̎v�l�̂����iMBTI�^�C�v�F${mbti})�z
�� �����̑�������ӎv����̌X�����o�Ă��B
�iMBTI���Ƃ̋��݂ƃN�Z��250�����ȓ��Łj

---

?�y�Z���w���猩���h���Ǝ����z
���Ȃ��̖����́u${dayStem}�v�̓����A�܍s�́u${element}�v����B
���_�́u${guardianSpirit}�v�ŁA�ȉ��̂悤�Ȏ����������Ă����B
${stemDescription}�i300�����ȓ��Łj

---

?�y���낭�܂���̃A�h�o�C�X�z

�ȉ���3���������킹�āA
�u���Ȃ��炵�����݁v�u�����₷���Y����M���b�v�v�u�ǂ��󂯓���Ă����΂������v
��**��̓I�E���H�I��600�`800������**�A�h�o�C�X���Ă��������B

- �����肢�́u${animalType}�v�̓���
- MBTI�^�C�v�u${mbti}�v�̎v�l�X��
- �܍s�u${element}�v�Ǝ��_�u${guardianSpirit}�v�̎���

�`���́A
1. ���� �� 2. �Y���̎w�E �� 3. ������Ǝ�e �� 4. �܂Ƃ�
�Ƃ���4�i�\���ŁA�K���������g�[���ŏ����Ă��������B

---

? ���̐f�f�́A�����肢�EMBTI�E�Z���w��3���|�����킹�Ă������A���Ȃ��̂��߂�����1���B

���ł����̔����܂����΂ɂ���Ǝv���āA�������Ƃ��͂܂��߂��Ă��ĂˁB
`;

      try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: [
            { role: 'system', content: '���Ȃ��͐e���݂₷�����ȕ��̓K�C�h�ł��锒���܂ł��B' },
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
          text: '�f�f���ɃG���[���������܂����B������x�����Ă݂ĂˁI'
        });
      }
    }
  }

  res.status(200).send('OK');
});

app.listen(3000, () => console.log('Server is running'));

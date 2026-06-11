require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 수집된 피드백을 메모리에 임시 보관 (재시작 시 초기화)
const feedbackStore = [];

// Figma URL에서 파일 키와 노드 ID 추출
function parseFigmaUrl(url) {
  const fileMatch = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9_-]+)/);
  if (!fileMatch) return null;

  const nodeMatch = url.match(/[?&]node-id=([^&\s]+)/);
  let nodeId = null;
  if (nodeMatch) {
    const decoded = decodeURIComponent(nodeMatch[1]);
    // 새 Figma URL 형식(하이픈)을 API 형식(콜론)으로 변환: "2048-3" -> "2048:3"
    nodeId = decoded.includes(':') ? decoded : decoded.replace('-', ':');
  }

  return { fileKey: fileMatch[1], nodeId };
}

// Figma API로 이미지 URL 가져오기
async function getFigmaImageUrl(fileKey, nodeId) {
  const response = await fetch(
    `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`,
    { headers: { 'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN } }
  );

  if (!response.ok) throw new Error(`Figma API 오류: ${response.status}`);

  const data = await response.json();
  if (data.err) throw new Error(`Figma 오류: ${data.err}`);

  const imageUrl = data.images[nodeId];
  if (!imageUrl) {
    throw new Error('노드 이미지를 찾을 수 없습니다. Figma에서 프레임을 선택한 후 URL을 복사해주세요.');
  }

  return imageUrl;
}

// 이미지 URL을 base64로 다운로드
async function downloadImageBase64(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error('이미지 다운로드 실패');
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// Claude로 배너 디자인 분석
async function analyzeBannerWithClaude(imageBase64) {
  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
          },
          {
            type: 'text',
            text: `이 배너 디자인에 대한 전문적인 피드백을 한국어로 제공해주세요.

다음 항목을 중심으로 분석해주세요:
1. *시각적 계층 구조*: 정보 우선순위와 시선 흐름
2. *타이포그래피*: 폰트 선택, 크기, 가독성
3. *색상 및 대비*: 색상 조화와 가독성
4. *레이아웃 균형*: 여백과 요소 배치
5. *메시지 전달력*: 핵심 메시지의 명확성
6. *개선 제안*: 구체적인 개선 방향 2~3가지

간결하고 실용적인 피드백으로 작성해주세요.`,
          },
        ],
      },
    ],
  });

  const msg = await stream.finalMessage();
  const textBlock = msg.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '분석 결과를 가져올 수 없습니다.';
}

// 봇 멘션 이벤트 처리
app.event('app_mention', async ({ event, client, say }) => {
  const { text, user, ts, channel, thread_ts } = event;

  // 멘션 태그를 제거하고 순수 메시지만 추출
  const feedbackText = text.replace(/<@[A-Z0-9]+>/g, '').trim();

  // 빈 멘션이면 사용법 안내
  if (!feedbackText) {
    await say({
      text: '피드백을 남겨주세요! 예시: `@피드백봇 앱이 더 빠르면 좋겠어요`',
      thread_ts: thread_ts || ts,
    });
    return;
  }

  try {
    // 피드백 저장
    const feedback = {
      user,
      channel,
      text: feedbackText,
      timestamp: new Date().toISOString(),
      slackTs: ts,
    };
    feedbackStore.push(feedback);

    // 유저 정보 조회
    const userInfo = await client.users.info({ user });
    const userName = userInfo.user?.real_name || userInfo.user?.name || user;

    // 스레드로 접수 확인 답장
    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *피드백이 접수되었습니다!*\n\n*${userName}*님의 소중한 피드백 감사합니다.`,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*내용:*\n${feedbackText}`,
            },
            {
              type: 'mrkdwn',
              text: `*접수 번호:*\n#${feedbackStore.length}`,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `접수 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
            },
          ],
        },
      ],
      text: `피드백 접수 완료: ${feedbackText}`,
      thread_ts: thread_ts || ts,
    });

    // 별도 피드백 수신 채널이 설정된 경우 해당 채널로 전달
    if (process.env.FEEDBACK_CHANNEL_ID && process.env.FEEDBACK_CHANNEL_ID !== channel) {
      await client.chat.postMessage({
        channel: process.env.FEEDBACK_CHANNEL_ID,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '📨 새 피드백이 도착했습니다',
            },
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*작성자:*\n<@${user}>`,
              },
              {
                type: 'mrkdwn',
                text: `*채널:*\n<#${channel}>`,
              },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*피드백 내용:*\n${feedbackText}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `접수 번호: #${feedbackStore.length} | ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
              },
            ],
          },
        ],
        text: `새 피드백: ${feedbackText}`,
      });
    }

    console.log(`[피드백 #${feedbackStore.length}] ${userName}: ${feedbackText}`);
  } catch (error) {
    console.error('피드백 처리 중 오류:', error);
    await say({
      text: '피드백 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
      thread_ts: thread_ts || ts,
    });
  }
});

// /피드백 슬래시 커맨드 처리
app.command('/피드백', async ({ command, ack, respond }) => {
  await ack();

  const text = command.text?.trim();

  // Figma 링크가 포함된 경우 배너 분석 실행
  if (text && text.includes('figma.com')) {
    if (!process.env.FIGMA_ACCESS_TOKEN) {
      await respond({ text: '⚠️ FIGMA_ACCESS_TOKEN이 설정되지 않았습니다. .env 파일을 확인해주세요.' });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      await respond({ text: '⚠️ ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일을 확인해주세요.' });
      return;
    }

    // 분석 시작 메시지 (본인에게만 표시)
    await respond({ text: '🔍 피그마 디자인을 분석 중입니다... 잠시만 기다려주세요.' });

    try {
      const parsed = parseFigmaUrl(text);
      if (!parsed) {
        await respond({ text: '❌ 유효한 Figma URL이 아닙니다.\n예시: `/피드백 https://www.figma.com/design/XXXX/Title?node-id=1-2`' });
        return;
      }
      if (!parsed.nodeId) {
        await respond({ text: '❌ node-id가 없습니다. Figma에서 분석할 프레임을 선택한 후 URL을 복사해주세요.' });
        return;
      }

      const imageUrl = await getFigmaImageUrl(parsed.fileKey, parsed.nodeId);
      const imageBase64 = await downloadImageBase64(imageUrl);
      const analysis = await analyzeBannerWithClaude(imageBase64);

      await respond({
        response_type: 'in_channel',
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '🎨 배너 디자인 피드백', emoji: true },
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: analysis },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `분석 완료 | ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
              },
            ],
          },
        ],
        text: analysis,
      });
    } catch (error) {
      console.error('배너 분석 오류:', error);
      await respond({ text: `❌ 분석 중 오류가 발생했습니다: ${error.message}` });
    }
    return;
  }

  // 기본 상태 확인
  await respond('피드백봇이 작동 중입니다!');
});

// DM 메시지 처리 (Messages 탭)
app.message(async ({ message, client, say }) => {
  // 봇 메시지, 서브타입(파일 공유 등) 무시
  if (message.subtype || message.bot_id) return;
  // DM 채널(im)만 처리
  if (message.channel_type !== 'im') return;

  const { user, text, ts } = message;
  const feedbackText = text?.trim();

  if (!feedbackText) return;

  try {
    const feedback = {
      user,
      channel: message.channel,
      text: feedbackText,
      timestamp: new Date().toISOString(),
      slackTs: ts,
    };
    feedbackStore.push(feedback);

    const userInfo = await client.users.info({ user });
    const userName = userInfo.user?.real_name || userInfo.user?.name || user;

    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *피드백이 접수되었습니다!*\n\n*${userName}*님의 소중한 피드백 감사합니다.`,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*내용:*\n${feedbackText}`,
            },
            {
              type: 'mrkdwn',
              text: `*접수 번호:*\n#${feedbackStore.length}`,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `접수 시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
            },
          ],
        },
      ],
      text: `피드백 접수 완료: ${feedbackText}`,
    });

    if (process.env.FEEDBACK_CHANNEL_ID) {
      await client.chat.postMessage({
        channel: process.env.FEEDBACK_CHANNEL_ID,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '📨 새 피드백이 도착했습니다' },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*작성자:*\n<@${user}>` },
              { type: 'mrkdwn', text: `*경로:*\nDM` },
            ],
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*피드백 내용:*\n${feedbackText}` },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `접수 번호: #${feedbackStore.length} | ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
              },
            ],
          },
        ],
        text: `새 피드백: ${feedbackText}`,
      });
    }

    console.log(`[피드백 #${feedbackStore.length}] DM | ${userName}: ${feedbackText}`);
  } catch (error) {
    console.error('DM 피드백 처리 중 오류:', error);
    await say({ text: '피드백 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

// 봇 시작
(async () => {
  await app.start();
  console.log('피드백봇이 시작되었습니다 (Socket Mode)');
})();

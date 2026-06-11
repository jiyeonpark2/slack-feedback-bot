require('dotenv').config();
const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// 수집된 피드백을 메모리에 임시 보관 (재시작 시 초기화)
const feedbackStore = [];

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
app.command('/피드백', async ({ ack, respond }) => {
  await ack();
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

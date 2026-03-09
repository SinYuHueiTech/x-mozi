import { CozeAPI, ChatEventType, RoleType, COZE_CN_BASE_URL } from '@coze/api';

export const runtime = 'nodejs';

/**
 * POST /api/chat
 * 流式聊天 - 与 AI 进行对话
 */
export async function POST(request: Request) {
  try {
    const { message, language, systemPrompt } = await request.json();

    if (!message || typeof message !== 'string') {
      return Response.json(
        { error: '请提供有效的消息内容' },
        { status: 400 }
      );
    }

    // 验证环境变量
    const apiKey = process.env.COZE_API_KEY;
    const botId = process.env.COZE_BOT_ID;

    if (!apiKey || !botId) {
      console.error('Chat: Coze 凭证未配置');
      return Response.json(
        { error: '服务配置错误' },
        { status: 500 }
      );
    }

    // 初始化 Coze Client
    const client = new CozeAPI({
      token: apiKey,
      baseURL: COZE_CN_BASE_URL,
      allowPersonalAccessTokenInBrowser: false,
    });

    const userId = 'x-mozi';
    const isEnglish = language === 'en';
    const prompt = systemPrompt || 'Please respond in English.';
    const finalMessage = isEnglish ? `${prompt}\n\n${message}` : message;

    // 使用 chat.stream 接口发起对话
    const stream = await client.chat.stream({
      bot_id: botId,
      user_id: userId,
      additional_messages: [
        {
          role: RoleType.User,
          content: finalMessage,
          content_type: 'text',
        },
      ],
      auto_save_history: true,
    });

    // 创建 ReadableStream 返回给前端
    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of stream) {
            if (part.event === ChatEventType.CONVERSATION_MESSAGE_DELTA) {
              const content = part.data.content;
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify({ content })}\n\n`)
              );
            }
          }
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        } catch (error) {
          console.error('Coze 流式响应错误:', error);
          controller.error(error);
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('Chat 错误:', error);
    const errorMessage = error instanceof Error ? error.message : '未知错误';
    return Response.json(
      { error: '聊天服务错误', details: errorMessage },
      { status: 500 }
    );
  }
}

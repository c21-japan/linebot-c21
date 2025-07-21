/// <reference types="node" />
// @ts-ignore
import 'dotenv/config';
import express from 'express';
import { Client, middleware } from '@line/bot-sdk';
import OpenAI from 'openai';
import { createClient } from 'redis';
import type { Request, Response } from 'express';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};
const lineClient = new Client(lineConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const redis = createClient({ url: process.env.REDIS_URL! });

const app = express();
// ここを /api/webhook に修正
app.post('/api/webhook', middleware(lineConfig), async (req: Request, res: Response) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event: any) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  // Redisから直近10件の履歴取得
  let history: any[] = [];
  try {
    history = await redis.lrange(`u:${event.source.userId}`, -10, -1);
  } catch (e) {
    history = [];
  }

  // プロンプト組立
  const messages = [
    { role: 'system', content: 'あなたは関西弁で親しみやすい不動産エージェントAIです。' },
    ...history.map((h) => JSON.parse(h)),
    { role: 'user', content: event.message.text },
  ];

  // GPT-4o呼び出し
  let reply = 'すみません、うまく答えられませんでした。';
  try {
    const gpt = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
    });
    reply = gpt.choices[0]?.message?.content ?? reply;
  } catch (e) {
    // エラー時は既定メッセージ
  }

  // LINEに返答
  await lineClient.replyMessage(event.replyToken, { type: 'text', text: reply });

  // 履歴保存
  await redis.rpush(`u:${event.source.userId}`, JSON.stringify({ role: 'assistant', content: reply }));
}

export default app; 
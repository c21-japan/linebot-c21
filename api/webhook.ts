import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client, validateSignature } from '@line/bot-sdk';
import OpenAI from 'openai';
import { createClient } from 'redis';
import 'dotenv/config';

// LINE SDKの設定
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

const client = new Client(lineConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const redis = createClient({ url: process.env.REDIS_URL });
let redisConnected = false;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Redis接続（初回のみ）
  if (!redisConnected) {
    await redis.connect();
    redisConnected = true;
  }

  // POST以外は拒否
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const signature = req.headers['x-line-signature'] as string;
  const rawBody = (req as any).rawBody;

  // シグネチャ検証
  const isValid = validateSignature(rawBody, lineConfig.channelSecret, signature);
  if (!isValid) {
    return res.status(401).send('Unauthorized');
  }

  const body = JSON.parse(rawBody.toString());
  const events = body.events;

  await Promise.all(events.map(async (event: any) => {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId;
    const key = `u:${userId}`;
    const userMessage = event.message.text;

    const historyRaw = await redis.lrange(key, -10, -1);
    const history = historyRaw.map((msg) => JSON.parse(msg));

    const messages = [
      { role: 'system', content: 'あなたは関西弁で親しみやすい不動産エージェントAIです。' },
      ...history,
      { role: 'user', content: userMessage },
    ];

    const chat = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
    });

    const reply = chat.choices[0]?.message?.content || 'うまく返せませんでした。';

    await client.replyMessage(event.replyToken, { type: 'text', text: reply });

    await redis
      .multi()
      .rpush(key, JSON.stringify({ role: 'user', content: userMessage }))
      .rpush(key, JSON.stringify({ role: 'assistant', content: reply }))
      .ltrim(key, -10, -1)
      .exec();
  }));

  return res.status(200).send('OK');
} 
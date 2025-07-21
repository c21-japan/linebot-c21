import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client, validateSignature } from '@line/bot-sdk';
import OpenAI from 'openai';
import { createClient } from 'redis';
import 'dotenv/config';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};
const client = new Client(lineConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Redisクライアントを初期化（再接続防止用）
let redisReady = false;
const redis = createClient({ url: process.env.REDIS_URL });
const ensureRedisConnected = async () => {
  if (!redisReady) {
    await redis.connect();
    redisReady = true;
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const signature = req.headers['x-line-signature'] as string;
  const rawBody = (req as any).rawBody;

  const isValid = validateSignature(rawBody, lineConfig.channelSecret, signature);
  if (!isValid) return res.status(401).send('Invalid Signature');

  try {
    const body = JSON.parse(rawBody.toString());
    const events = body.events;

    await ensureRedisConnected();

    await Promise.all(events.map(async (event: any) => {
      if (event.type !== 'message' || event.message.type !== 'text') return;

      const userId = event.source.userId;
      const key = `u:${userId}`;
      const messageText = event.message.text;

      const historyRaw = await redis.lrange(key, -10, -1);
      const history = historyRaw.map(JSON.parse);

      const messages = [
        { role: 'system', content: 'あなたは関西弁で親しみやすい不動産エージェントAIです。' },
        ...history,
        { role: 'user', content: messageText }
      ];

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages
      });

      const reply = completion.choices[0]?.message?.content || 'うまく返せませんでした。';
      await client.replyMessage(event.replyToken, { type: 'text', text: reply });

      await redis.multi()
        .rpush(key, JSON.stringify({ role: 'user', content: messageText }))
        .rpush(key, JSON.stringify({ role: 'assistant', content: reply }))
        .ltrim(key, -10, -1)
        .exec();
    }));

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ webhook error:', err);
    res.status(500).send('Internal Server Error');
  }
} 
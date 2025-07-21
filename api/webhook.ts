import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client, middleware } from '@line/bot-sdk';
import OpenAI from 'openai';
import { createClient } from 'redis';
import 'dotenv/config';

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};
const client = new Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const redis = createClient({ url: process.env.REDIS_URL });
redis.connect();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const events = req.body.events;
  if (!events || !Array.isArray(events)) return res.status(400).send('Invalid body');

  await Promise.all(events.map(async (event) => {
    if (event.type !== 'message' || event.message.type !== 'text') return;

    const userId = event.source.userId;
    const key = `u:${userId}`;

    let history: any[] = [];
    try {
      const raw = await redis.lrange(key, -10, -1);
      history = raw.map((h) => JSON.parse(h));
    } catch (e) {
      history = [];
    }

    const messages = [
      { role: 'system', content: 'あなたは関西弁で親しみやすい不動産エージェントAIです。' },
      ...history,
      { role: 'user', content: event.message.text },
    ];

    const chat = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
    });

    const reply = chat.choices[0]?.message?.content || 'うまく返せませんでした。';
    await client.replyMessage(event.replyToken, { type: 'text', text: reply });

    await redis.multi()
      .rpush(key, JSON.stringify({ role: 'user', content: event.message.text }))
      .rpush(key, JSON.stringify({ role: 'assistant', content: reply }))
      .ltrim(key, -10, -1)
      .exec();
  }));

  return res.status(200).send('OK');
} 
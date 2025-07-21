import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client, validateSignature } from '@line/bot-sdk';
import OpenAI from 'openai';
import { createClient, RedisClientType } from 'redis';
import 'dotenv/config';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};
const client = new Client(lineConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

let redis: RedisClientType | null = null;

const getRedis = async (): Promise<RedisClientType> => {
  if (!redis) {
    redis = createClient({ url: process.env.REDIS_URL });
    redis.on('error', (err) => {
      console.error('❌ Redis error:', err);
      redis?.quit();
      redis = null;
    });
    await redis.connect();
  }

  if (!redis.isReady) {
    await redis.connect();
  }

  return redis;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const signature = req.headers['x-line-signature'] as string;
    const rawBody = (req as any).rawBody;
    const isValid = validateSignature(rawBody, lineConfig.channelSecret, signature);
    if (!isValid) return res.status(401).send('Invalid Signature');

    const body = JSON.parse(rawBody.toString());
    const events = body.events;

    const redisClient = await getRedis();

    await Promise.all(events.map(async (event: any) => {
      if (event.type !== 'message' || event.message.type !== 'text') return;

      const userId = event.source.userId;
      const key = `u:${userId}`;
      const message = event.message.text;

      const historyRaw = await redisClient.lrange(key, -10, -1);
      const history = historyRaw.map(JSON.parse);

      const messages = [
        { role: 'system', content: 'あなたは関西弁で親しみやすい不動産エージェントAIです。' },
        ...history,
        { role: 'user', content: message }
      ];

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages
      });

      const reply = completion.choices[0]?.message?.content || 'うまく返せませんでした。';
      await client.replyMessage(event.replyToken, { type: 'text', text: reply });

      await redisClient
        .multi()
        .rpush(key, JSON.stringify({ role: 'user', content: message }))
        .rpush(key, JSON.stringify({ role: 'assistant', content: reply }))
        .ltrim(key, -10, -1)
        .exec();
    }));

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ webhook error:', err);
    res.status(200).send('Error Handled'); // LINE側が200を求めるため
  }
} 
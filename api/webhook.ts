import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client, validateSignature } from '@line/bot-sdk';
import OpenAI from 'openai';
import { createClient, RedisClientType } from 'redis';
import 'dotenv/config';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};
const client = new Client(lineConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

let redis: RedisClientType | null = null;

const getRedis = async () => {
  try {
    if (!redis) {
      redis = createClient({ url: process.env.REDIS_URL });
      redis.on('error', (err) => {
        console.error('❌ Redis error:', err);
        redis = null;
      });
      await redis.connect();
    }
    return redis;
  } catch (err) {
    console.error('❌ Redis connection failed:', err);
    return null;
  }
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

    await Promise.all(events.map(async (event: any) => {
      if (event.type !== 'message' || event.message.type !== 'text') return;

      const redisClient = await getRedis();
      const userId = event.source.userId;
      const key = `u:${userId}`;
      const message = event.message.text;

      let history: ChatCompletionMessageParam[] = [];
      if (redisClient) {
        try {
          const historyRaw = await redisClient.lRange(key, -10, -1);
          history = historyRaw.map((h) => JSON.parse(h) as ChatCompletionMessageParam);
        } catch (e) {
          console.error('Redis lRange failed:', e);
        }
      }

      const messages: ChatCompletionMessageParam[] = [
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

      if (redisClient) {
        try {
          await redisClient
            .multi()
            .rPush(key, JSON.stringify({ role: 'user', content: message }))
            .rPush(key, JSON.stringify({ role: 'assistant', content: reply }))
            .lTrim(key, -10, -1)
            .exec();
        } catch (e) {
          console.error('Redis save failed:', e);
        }
      }
    }));

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ webhook error:', err);
    res.status(200).send('Webhook error handled');
  }
}
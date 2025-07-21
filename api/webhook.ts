import { VercelRequest, VercelResponse } from '@vercel/node';
import { Client, validateSignature } from '@line/bot-sdk';
import OpenAI from 'openai';
import 'dotenv/config';

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};
const client = new Client(lineConfig);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

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

      const userMessage = event.message.text;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'あなたは関西弁で親しみやすい不動産エージェントAIです。' },
          { role: 'user', content: userMessage }
        ]
      });

      const reply = completion.choices[0]?.message?.content || 'うまく返せませんでした。';
      await client.replyMessage(event.replyToken, { type: 'text', text: reply });
    }));

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ webhook error:', err);
    res.status(200).send('Error Handled');
  }
}
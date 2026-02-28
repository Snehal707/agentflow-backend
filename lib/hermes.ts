import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const hermes = new OpenAI({
  baseURL: process.env.HERMES_BASE_URL,
  apiKey: process.env.HERMES_API_KEY,
});

export async function callHermes(systemPrompt: string, userMessage: string) {
  if (!process.env.HERMES_MODEL) {
    throw new Error('HERMES_MODEL is not set in environment');
  }

  const response = await hermes.chat.completions.create({
    model: process.env.HERMES_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? '';
}


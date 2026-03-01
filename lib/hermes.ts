import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

// Hermes = Nous Research model (OpenAI-compatible API); default model: Hermes-4-405B
const hermes = new OpenAI({
  baseURL: process.env.HERMES_BASE_URL,
  apiKey: process.env.HERMES_API_KEY,
});

export async function callHermes(systemPrompt: string, userMessage: string) {
  const model = process.env.HERMES_MODEL || 'Hermes-4-405B';
  const response = await hermes.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? '';
}


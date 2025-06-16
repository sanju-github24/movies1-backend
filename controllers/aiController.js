import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function generateSummary(req, res) {
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, error: 'Title is required' });
  }

  try {
    const prompt = `Write a short and exciting movie description for a film titled "${title}". Keep it under 3 lines.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a movie summary generator for a movie admin panel.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 100,
      temperature: 0.7,
    });

    const summary = response.choices[0]?.message?.content.trim();

    res.json({ success: true, summary });
  } catch (err) {
    console.error('AI error:', err);
    res.status(500).json({ success: false, error: 'Failed to generate summary' });
  }
}

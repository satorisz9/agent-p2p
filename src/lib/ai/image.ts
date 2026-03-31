/**
 * AI Image Generation — generate token/project icons via OpenAI or Gemini.
 *
 * Supports:
 *   - OpenAI gpt-image-1 (OPENAI_API_KEY)
 *   - Google Gemini imagen (GEMINI_API_KEY) — fallback
 */

export interface ImageResult {
  success: boolean;
  buffer?: Buffer;
  error?: string;
}

/**
 * Generate a project/token icon image.
 * Tries OpenAI first, falls back to Gemini.
 */
export async function generateIcon(
  projectName: string,
  symbol: string,
  description: string
): Promise<ImageResult> {
  const prompt = `A clean, modern icon/logo for a crypto token called "${symbol}" (${projectName}). ${description}. Minimalist design, suitable for a token icon on a dark background. Square format, no text.`;

  // Try OpenAI gpt-image-1
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt,
          n: 1,
          size: "1024x1024",
        }),
      });
      const data = await res.json() as any;
      if (data.data?.[0]?.b64_json) {
        return { success: true, buffer: Buffer.from(data.data[0].b64_json, "base64") };
      }
      // gpt-image-1 might return URL instead
      if (data.data?.[0]?.url) {
        const imgRes = await fetch(data.data[0].url);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        return { success: true, buffer: buf };
      }
      return { success: false, error: `OpenAI: ${JSON.stringify(data.error || data)}` };
    } catch (err: any) {
      console.error(`[AI Image] OpenAI failed: ${err.message}`);
    }
  }

  // Try Gemini
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Generate an image: ${prompt}`,
              }],
            }],
            generationConfig: {
              responseModalities: ["IMAGE", "TEXT"],
            },
          }),
        }
      );
      const data = await res.json() as any;
      const parts = data.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith("image/")) {
          return { success: true, buffer: Buffer.from(part.inlineData.data, "base64") };
        }
      }
      return { success: false, error: `Gemini: no image in response` };
    } catch (err: any) {
      console.error(`[AI Image] Gemini failed: ${err.message}`);
    }
  }

  return { success: false, error: "No API key set. Set OPENAI_API_KEY or GEMINI_API_KEY." };
}

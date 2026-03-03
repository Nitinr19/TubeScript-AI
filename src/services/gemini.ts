import { GoogleGenAI, Type } from "@google/genai";

const SYSTEM_INSTRUCTION = `You are an expert content analyst. Your task is to provide a high-quality, structured summary of a YouTube video transcript.
Follow these rules strictly:
1. Use the transcript as the ONLY source of truth.
2. Do NOT hallucinate. If information is missing, state it is unavailable.
3. Be specific: preserve names, numbers, steps, and constraints.
4. Output in Markdown format with the specific sections requested.
5. Include a 'Knowledge Graph Lite' section listing entities and relationships.`;

const SUMMARY_PROMPT = (transcript: string, structure: string) => `
Please provide a detailed, structured summary of the following YouTube transcript.

Transcript:
${transcript}

Structure the summary with these sections:
${structure}
`;

export async function generateSummary(transcript: string, summaryStructure?: string, onStream?: (text: string) => void) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini API key is missing. Please configure it in the Secrets panel.");
  }

  const ai = new GoogleGenAI({ apiKey });
  
  const defaultStructure = `1. TL;DR (5-8 bullets, punchy)
2. Detailed Outline (H2/H3 headings)
3. Key Concepts & Definitions (term → definition)
4. Step-by-step / Process (if applicable)
5. Examples Mentioned (bulleted)
6. Tools / Frameworks / Names mentioned (bulleted)
7. "If I only remember 10 things" (top takeaways)
8. Action Items / Next Steps (if applicable)
9. Open Questions / Uncertainties
10. Time Index (map major sections to approximate timestamps if available in transcript)
11. Knowledge Graph Lite (list entities like people/tools/concepts and their relationships)`;

  const response = await ai.models.generateContentStream({
    model: "gemini-3-flash-preview",
    contents: [{ parts: [{ text: SUMMARY_PROMPT(transcript, summaryStructure || defaultStructure) }] }],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.2,
    },
  });

  let fullText = "";
  for await (const chunk of response) {
    const text = chunk.text;
    if (text) {
      fullText += text;
      onStream?.(fullText);
    }
  }

  return fullText;
}

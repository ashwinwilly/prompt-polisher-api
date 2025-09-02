// src/app/api/rewrite/route.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

export const runtime = "edge";

const FAST_MODEL   = process.env.FAST_MODEL   || "gpt-4.1-mini";
const MEDIUM_MODEL = process.env.MEDIUM_MODEL || "gpt-4.1";
const SLOW_MODEL   = process.env.SLOW_MODEL   || "gpt-4.1";

type Mode = "fast" | "medium" | "slow";

function pickModel(mode: Mode) {
  if (mode === "fast") return FAST_MODEL;
  if (mode === "medium") return MEDIUM_MODEL;
  return SLOW_MODEL;
}

// --- Code-fence preservation ---
function extractCodeBlocks(src: string) {
  const blocks: string[] = [];
  const replaced = src.replace(/```[\s\S]*?```/g, (m) => {
    const id = blocks.push(m) - 1;
    return `[[[CODEBLOCK_${id}]]]`;
  });
  return { replaced, blocks };
}
function restoreCodeBlocks(text: string, blocks: string[]) {
  let out = text;
  blocks.forEach((code, i) => {
    out = out.replace(new RegExp(`\\[\\[\\[CODEBLOCK_${i}\\]\\]\\]`, "g"), code);
  });
  return out;
}

function buildInstructions(mode: Mode) {


  if (mode === "fast") {
    return `You are a prompt rewriter. Rewrite the user’s request into a clearer, more effective prompt that preserves intent exactly.

Always return in this structure:
Role: [insert role inferred from the request — e.g., tutor, historian, coder, planner]
Goal: [restate the user’s request as a clear, single-sentence goal]
Constraints:
1) Be concise and clear.
2) Use an output format that fits the task (for problems: steps + final answer; for essays: outline + draft; for Q&A: short answer → key points).
3) Avoid adding new requirements or fabricating details.

Task: [the cleaned version of the user’s request]

Do not answer the task. Return only the rewritten prompt.`
;
  }
  if (mode === "medium") {
    return `You are a prompt rewriter for an AI assistant. Your job is to produce the most effective single prompt for the assistant to answer.

Steps:
1. Infer the task type: {STEM/Problem, Essay/Writing, Summary/Notes, Planning, Code, General Q&A, Creative}.
2. Choose the best output format for that type (e.g., steps+answer, outline+draft, TL;DR+bullets).
3. Rewrite the user’s request with this structure:
   Role: [role suited to the task, optional]
   Goal: [restate the user’s request as a clear goal]
   Constraints:
   1) …
   2) …
   3) …
   Format: [the output structure you chose]
   Task: [the cleaned version of the request]
4. If the request is missing essential info, add one line “Assumptions:” with ≤2 neutral defaults (e.g., audience=general reader, concise output).

Rules:
- Preserve the user’s intent exactly.
- Never add demands the user didn’t ask for.
- Do not answer the task.

Return only the rewritten prompt.

`;
  }
  return `You are a prompt rewriter for another AI assistant. Your goal is to maximize output quality while keeping the rewritten prompt as concise as possible.

1. Infer the task type: {STEM, Essay, Summary, Planning, Code, Q&A, Creative}.
2. Choose the smallest useful scaffold among:
   - F1: Format only
   - F2: Constraints only
   - F3: Goal + Format
   - F4: Goal + Constraints + Format
   - F5: Role + Goal + Constraints + Format
   Always prefer the lowest-numbered option that still improves clarity and reliability.
3. Construct the rewritten prompt with only the sections needed (Role, Goal, Constraints, Assumptions, Format, Task).
4. If critical info is missing, add one “Assumptions:” line with ≤2 neutral defaults. Otherwise omit.
5. Never add requirements not asked by the user.

Return only the rewritten prompt. Do not answer the task.

User request:
{{RAW_USER_TEXT}}

`;
}

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { headers: corsHeaders(origin) });
}

// --- Helpers to safely extract text from Responses API ---
function extractFromResponsesJson(j: any): string {
  // 1) Preferred: aggregated convenience field
  if (j?.output_text && typeof j.output_text === "string") return j.output_text;

  // 2) Some shapes: j.output is an array of items (messages, tool calls, etc.)
  if (Array.isArray(j?.output)) {
    const parts: string[] = [];
    for (const item of j.output) {
      // message with content array of text blocks
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const text = c?.text ?? c?.value ?? c?.content ?? "";
          if (typeof text === "string") parts.push(text);
        }
      }
      // sometimes item itself has .text
      if (typeof item?.text === "string") parts.push(item.text);
    }
    if (parts.length) return parts.join("\n").trim();
  }

  // 3) Fallback: some SDKs put text under top-level message-like objects
  const maybe = j?.message?.content?.[0]?.text || j?.content?.[0]?.text;
  if (typeof maybe === "string") return maybe.trim();

  return "";
}

export async function POST(req: Request) {
  const t0 = Date.now();
  const origin = req.headers.get("origin");

  try {
    const { prompt, mode } = (await req.json()) as {
      prompt?: string;
      mode?: Mode;
    };

    if (!prompt || !mode) {
      return new Response(
        JSON.stringify({ error: "missing_prompt_or_mode" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }

    const { replaced, blocks } = extractCodeBlocks(prompt);
    const instructions = buildInstructions(mode);
    const model = pickModel(mode);

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return new Response(
        JSON.stringify({ error: "server_missing_OPENAI_API_KEY" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
      );
    }

    // --- Try Responses API first ---
    const responsesRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        instructions,
        input: replaced,
        temperature: 0.2,
        max_output_tokens: 1200,
      }),
    });

    let improved = "";
    let used = "responses";

    if (responsesRes.ok) {
      const j = await responsesRes.json();
      const text = extractFromResponsesJson(j);
      if (text) {
        improved = text.trim();
      }
    }

    // --- If no text extracted, fall back to Chat Completions ---
    if (!improved) {
      const chatRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: replaced },
          ],
          // generous cap; server-side budgets are enforced in the extension anyway
          max_tokens: 1200,
        }),
      });

      if (!chatRes.ok) {
        const detail = await chatRes.text();
        return new Response(
          JSON.stringify({ error: "openai_error", detail }),
          { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
        );
      }

      const j = await chatRes.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      improved = (text || "").trim();
      used = "chat_completions";
    }

    // Restore code blocks and return
    improved = restoreCodeBlocks(improved, blocks);

    return new Response(
      JSON.stringify({ improved, meta: { model, api: used, durationMs: Date.now() - t0 } }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "unhandled", detail: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } }
    );
  }
}

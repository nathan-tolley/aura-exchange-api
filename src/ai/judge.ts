import OpenAI from "openai";
import { config } from "../config.js";
import type { AuraJudge, AuraJudgeInput, AuraJudgeResult, AuraVerdict } from "../types.js";

const verdicts: AuraVerdict[] = ["GAIN", "LOSS", "NEUTRAL", "REVIEW"];
const policyFlags = [
  "credible_threat",
  "personal_data",
  "illegal_content",
  "protected_class_attack",
  "sexual_exploitation",
  "targeted_harassment"
] as const;

class FakeAuraJudge implements AuraJudge {
  async judge(input: AuraJudgeInput): Promise<AuraJudgeResult> {
    const text = input.explanation.toLowerCase();
    const lossWords = ["spilled", "forgot", "broke", "late", "cringe", "fumbled", "lost", "burned"];
    const gainWords = ["fixed", "saved", "nailed", "won", "legend", "clutch", "brought", "helped"];
    const gain = gainWords.reduce((score, word) => score + Number(text.includes(word)), 0);
    const loss = lossWords.reduce((score, word) => score + Number(text.includes(word)), 0);
    const score = Math.max(-5, Math.min(5, gain - loss || (text.length % 5) - 2));
    const delta = score === 0 ? 0 : score;
    const verdict: AuraVerdict = delta > 0 ? "GAIN" : delta < 0 ? "LOSS" : "NEUTRAL";
    return {
      verdict,
      delta,
      confidence: 0.82,
      rationale: delta > 0 ? "Certified office aura—timing and execution were undeniable." : delta < 0 ? "The room witnessed a measurable aura drawdown." : "Funny filing, but the aura books stay flat.",
      category: delta > 0 ? "CLUTCH" : delta < 0 ? "FUMBLE" : "LORE",
      policyFlags: [],
      provider: "fake",
      model: "deterministic-test-judge"
    };
  }
}

class OpenAIAuraJudge implements AuraJudge {
  private readonly client: OpenAI;

  constructor() {
    if (!config.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  async judge(input: AuraJudgeInput): Promise<AuraJudgeResult> {
    const response = await this.client.responses.create({
      model: config.AI_MODEL,
      store: false,
      instructions: [
        "You are the judge for Aura Exchange, an adult, consensual office-friend-group game.",
        "Judge social aura, not morality or job performance. Reward competence, audacity, timing, cleverness, generosity, and legendary commitment.",
        "Deduct aura for cringe, fumbling, avoidable chaos, bad timing, or spectacular self-owns.",
        "Profanity, roasting, absurdity, and dark humor are allowed and should be judged normally.",
        "Flag credible threats, exposed personal data, illegal content, protected-class attacks, sexual exploitation, or sustained targeted harassment.",
        "Use REVIEW if context is too ambiguous. Keep the public rationale punchy, non-factual, and under 140 characters.",
        "GAIN delta must be 1..10, LOSS -10..-1, NEUTRAL 0, REVIEW 0."
      ].join("\n"),
      input: JSON.stringify({
        subject: input.subjectKey,
        event: input.explanation,
        relevantLore: input.glossary
      }),
      text: {
        format: {
          type: "json_schema",
          name: "aura_ruling",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              verdict: { type: "string", enum: verdicts },
              delta: { type: "integer", minimum: -10, maximum: 10 },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string" },
              category: { type: "string" },
              policyFlags: { type: "array", items: { type: "string", enum: policyFlags } }
            },
            required: ["verdict", "delta", "confidence", "rationale", "category", "policyFlags"]
          }
        }
      }
    });
    const parsed = JSON.parse(response.output_text) as Omit<AuraJudgeResult, "provider" | "model" | "requestId">;
    const delta = parsed.verdict === "GAIN" ? Math.max(1, parsed.delta) : parsed.verdict === "LOSS" ? Math.min(-1, parsed.delta) : 0;
    return {
      ...parsed,
      delta,
      rationale: parsed.rationale.slice(0, 280),
      provider: "openai",
      model: config.AI_MODEL,
      requestId: response.id
    };
  }
}

export function createAuraJudge(): AuraJudge {
  return config.AI_PROVIDER === "openai" ? new OpenAIAuraJudge() : new FakeAuraJudge();
}


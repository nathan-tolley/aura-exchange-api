import OpenAI from "openai";
import { config } from "../config.js";
import type { AuraJudge, AuraJudgeInput, AuraJudgeResult, AuraVerdict } from "../types.js";
import { getChatGPTPlanAccess } from "../services/chatgpt-plan-service.js";

const verdicts: AuraVerdict[] = ["GAIN", "LOSS", "NEUTRAL", "REVIEW"];
const policyFlags = [
  "credible_threat", "personal_data", "illegal_content", "protected_class_attack",
  "sexual_exploitation", "targeted_harassment"
] as const;

const instructions = [
  "You are the judge for Aura Exchange, an adult, consensual friend-group game.",
  "Judge social aura, not morality or job performance. Reward competence, audacity, timing, cleverness, generosity, and legendary commitment.",
  "Deduct aura for cringe, fumbling, avoidable chaos, bad timing, or spectacular self-owns.",
  "Profanity, roasting, absurdity, and dark humor are allowed and should be judged normally.",
  "Use REVIEW if context is too ambiguous. Keep the public rationale punchy, non-factual, and under 140 characters.",
  "When a prior ruling is supplied, the community requested reconsideration. Re-evaluate independently and return a final ruling.",
  "Use the full scoring range when deserved: 1..5 is routine, 6..15 is notable, 16..24 is legendary or disastrous, and 25..30 is exceptionally rare.",
  "GAIN delta must be 1..30, LOSS -30..-1, NEUTRAL 0, REVIEW 0."
].join("\n");

const rulingFormat = {
  type: "json_schema" as const, name: "aura_ruling", strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: verdicts }, delta: { type: "integer", minimum: -30, maximum: 30 },
      confidence: { type: "number", minimum: 0, maximum: 1 }, rationale: { type: "string" }, category: { type: "string" },
      policyFlags: { type: "array", items: { type: "string", enum: policyFlags } }
    },
    required: ["verdict", "delta", "confidence", "rationale", "category", "policyFlags"]
  }
};

function finish(parsed:Omit<AuraJudgeResult,"provider"|"model"|"requestId">,provider:string,model:string,requestId?:string):AuraJudgeResult {
  const delta=parsed.verdict==="GAIN"?Math.min(30,Math.max(1,parsed.delta)):parsed.verdict==="LOSS"?Math.max(-30,Math.min(-1,parsed.delta)):0;
  return {...parsed,delta,rationale:parsed.rationale.slice(0,280),provider,model,requestId};
}

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
      instructions,
      input: JSON.stringify({
        subject: input.subjectKey,
        event: input.explanation,
        relevantLore: input.glossary,
        reconsideration: input.reconsideration
      }),
      text: { format: rulingFormat }
    });
    const parsed = JSON.parse(response.output_text) as Omit<AuraJudgeResult, "provider" | "model" | "requestId">;
    return finish(parsed,"openai",config.AI_MODEL,response.id);
  }
}

class ChatGPTPlanAuraJudge implements AuraJudge {
  constructor(private readonly accessToken:string,private readonly model:string){}
  async judge(input:AuraJudgeInput):Promise<AuraJudgeResult>{
    const client=new OpenAI({apiKey:this.accessToken,maxRetries:0});
    const stream=await client.responses.create({model:this.model,store:false,stream:true,instructions,input:[{role:"user",content:JSON.stringify({subject:input.subjectKey,event:input.explanation,relevantLore:input.glossary,reconsideration:input.reconsideration})}],text:{format:rulingFormat}});
    let output="",requestId:string|undefined,completed=false;
    for await(const event of stream){
      if(event.type==="response.output_text.delta")output+=event.delta;
      else if(event.type==="response.completed"){completed=true;requestId=event.response.id;}
      else if(event.type==="response.failed")throw new Error(`ChatGPT plan ruling failed: ${event.response.error?.code??"unknown_error"}`);
    }
    if(!completed)throw new Error("ChatGPT plan response ended before completion.");
    return finish(JSON.parse(output) as Omit<AuraJudgeResult,"provider"|"model"|"requestId">,"chatgpt-plan",this.model,requestId);
  }
}

export async function createAuraJudge(): Promise<AuraJudge> {
  const plan=await getChatGPTPlanAccess();
  if(plan)return new ChatGPTPlanAuraJudge(plan.accessToken,plan.model);
  return config.AI_PROVIDER === "openai" ? new OpenAIAuraJudge() : new FakeAuraJudge();
}


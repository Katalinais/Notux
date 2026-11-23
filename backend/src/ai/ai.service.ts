import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ApiError, ErrorCode } from '../common/api-error';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { buildUserPrompt, checkQuiz, type Quiz, type QuizNote, QuizSchema, SYSTEM_PROMPT } from './quiz';

export const QUIZ_MODEL = 'claude-opus-5-5';

/** The one place that talks to Claude. Swapped for a fake in tests. */
@Injectable()
export class AiClient {
  private readonly client: Anthropic | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  /** null when Claude declined (stop_reason "refusal") or the output couldn't be parsed. */
  async generateQuiz(notes: QuizNote[], count: number): Promise<Quiz | null> {
    if (!this.client) throw new Error('AI is not configured');
    const response = await this.client.beta.messages.parse(
      {
        model: QUIZ_MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(notes, count) }],
        output_config: { effort: 'medium', format: betaZodOutputFormat(QuizSchema) },
        // If a safety classifier declines, the API retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { timeout: 90_000 },
    );
    if (response.stop_reason === 'refusal') return null;
    return response.parsed_output;
  }
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly ai: AiClient) {}

  async quiz(notes: QuizNote[], count: number): Promise<Quiz> {
    if (!this.ai.configured) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.AI_NOT_CONFIGURED, 'AI features are not set up');
    }
    let quiz: Quiz | null;
    try {
      quiz = await this.ai.generateQuiz(notes, count);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        this.logger.warn(`Claude busy: ${err.status}`);
      } else if (err instanceof Anthropic.APIError) {
        this.logger.error(`Claude API error ${err.status}: ${err.message}`);
      } else {
        this.logger.error(`Quiz generation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, ErrorCode.AI_UNAVAILABLE, 'Could not generate the quiz now');
    }
    const checked = quiz && checkQuiz(quiz, count);
    if (!checked?.questions.length) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        ErrorCode.AI_REFUSED,
        'Could not make a quiz from these notes',
      );
    }
    return checked;
  }
}

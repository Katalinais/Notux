import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { ApiError, ErrorCode } from '../common/api-error';
import { AiService } from './ai.service';
import type { Quiz } from './quiz';

export const MAX_NOTES = 40;
export const MAX_NOTE_CHARS = 6000;
export const MAX_TOTAL_CHARS = 60_000;

class QuizNoteDto {
  @ApiProperty({ example: 'Tipos de JOIN' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ example: 'INNER: solo coincidencias…' })
  @IsString()
  @MaxLength(MAX_NOTE_CHARS)
  text!: string;
}

class QuizRequestDto {
  @ApiProperty({
    type: [QuizNoteDto],
    description: `1 to ${MAX_NOTES} notes, at most ${MAX_TOTAL_CHARS} characters in all`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_NOTES)
  @ValidateNested({ each: true })
  @Type(() => QuizNoteDto)
  notes!: QuizNoteDto[];

  @ApiProperty({ minimum: 3, maximum: 15, example: 8 })
  @IsInt()
  @Min(3)
  @Max(15)
  count!: number;
}

class QuizQuestionDto {
  @ApiProperty() question!: string;
  @ApiProperty({ type: [String] }) options!: string[];
  @ApiProperty({ description: '0-3' }) correctIndex!: number;
  @ApiProperty() explanation!: string;
  @ApiProperty() sourceNote!: string;
}

class QuizDto {
  @ApiProperty() title!: string;
  @ApiProperty({ type: [QuizQuestionDto] }) questions!: QuizQuestionDto[];
}

@ApiTags('ai')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('quiz')
  @HttpCode(HttpStatus.OK)
  // Each call costs money: a handful per minute is plenty for studying.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Generate a multiple-choice quiz from notes (Claude).' })
  @ApiOkResponse({ type: QuizDto })
  @ApiUnprocessableEntityResponse({ description: '`{ code: "AI_REFUSED" }`: no usable quiz from these notes' })
  @ApiServiceUnavailableResponse({ description: '`{ code: "AI_NOT_CONFIGURED" | "AI_UNAVAILABLE" }`' })
  quiz(@Body() body: QuizRequestDto): Promise<Quiz> {
    const notes = body.notes
      .map((n) => ({ title: n.title.trim() || 'Sin título', text: n.text.trim() }))
      .filter((n) => n.text);
    if (!notes.length) throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.AI_REFUSED, 'The notes are empty');
    const total = notes.reduce((sum, n) => sum + n.title.length + n.text.length, 0);
    if (total > MAX_TOTAL_CHARS) {
      throw new ApiError(HttpStatus.BAD_REQUEST, ErrorCode.AI_TOO_MUCH_TEXT, 'Too much text: choose fewer notes');
    }
    return this.ai.quiz(notes, body.count);
  }
}

import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiClient, AiService } from './ai.service';

@Module({
  controllers: [AiController],
  providers: [AiClient, AiService],
})
export class AiModule {}

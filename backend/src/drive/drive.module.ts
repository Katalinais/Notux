import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { DriveClient } from './drive.client';
import { DriveController } from './drive.controller';
import { DriveService } from './drive.service';

@Module({
  imports: [UsersModule],
  controllers: [DriveController],
  providers: [DriveService, DriveClient],
})
export class DriveModule {}

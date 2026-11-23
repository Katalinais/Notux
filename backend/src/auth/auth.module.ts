import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginCodeService } from './login-code.service';
import { RefreshTokenService } from './refresh-token.service';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [AuthService, LoginCodeService, RefreshTokenService],
})
export class AuthModule {}

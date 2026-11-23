import { Global, Module } from '@nestjs/common';
import { GoogleOAuthService } from './google-oauth.service';

@Global()
@Module({
  providers: [GoogleOAuthService],
  exports: [GoogleOAuthService],
})
export class GoogleModule {}

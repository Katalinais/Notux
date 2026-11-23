import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { UserDto } from '../users/user.dto';

export class ExchangeDto {
  @ApiProperty({ description: 'The `login_code` received in the post-login redirect.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  code!: string;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  refreshToken!: string;
}

export class TokenPairDto {
  @ApiProperty({ description: 'JWT, send as `Authorization: Bearer <accessToken>`.' })
  accessToken!: string;

  @ApiProperty({ description: 'Opaque, single use (rotated on every refresh), 30 days.' })
  refreshToken!: string;

  @ApiProperty({ description: 'Access token lifetime in seconds.', example: 900 })
  expiresIn!: number;
}

export class SessionDto extends TokenPairDto {
  @ApiProperty({ type: UserDto })
  user!: UserDto;
}

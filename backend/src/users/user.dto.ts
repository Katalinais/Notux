import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  @ApiProperty({ example: 'clx0abc123' })
  id!: string;

  @ApiProperty({ example: 'estudiante@example.com' })
  email!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Ana Pérez' })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'https://lh3.googleusercontent.com/a/...' })
  picture!: string | null;

  @ApiProperty({ description: 'We hold a usable Google refresh token with the drive.file scope.' })
  driveConnected!: boolean;
}

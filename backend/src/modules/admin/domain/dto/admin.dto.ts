import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateAdminRequestDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  @Matches(/^[a-zA-Z0-9_.-]+$/, { message: 'name must be alphanumeric with . _ -' })
  name!: string;
}

export class SetAdminActiveRequestDto {
  @IsBoolean()
  isActive!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RotateAdminKeyRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AdminResponseDto {
  id!: string;
  name!: string;
  isActive!: boolean;
  createdAt!: string;
  updatedAt!: string | null;
}

export class AdminCreatedResponseDto extends AdminResponseDto {
  plaintextKey!: string;
}

export class AdminKeyRotatedResponseDto {
  id!: string;
  plaintextKey!: string;
}

import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateApiKeyRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientName?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  rateLimitRps?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  whiteList?: string;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  expiresAt?: Date;
}

export class UpdateApiKeyRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  clientName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  rateLimitRps?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  whiteList?: string | null;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  expiresAt?: Date | null;
}

export class SetActiveRequestDto {
  @IsBoolean()
  isActive!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ApiKeyResponseDto {
  id!: string;
  clientName!: string | null;
  key!: string;
  rateLimitRps!: number;
  whiteList!: string | null;
  expiresAt!: string | null;
  isActive!: boolean;
  createdAt!: string;
  updatedAt!: string | null;
}

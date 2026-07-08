import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, ValidateNested } from 'class-validator';

const HEX = /^0x[a-fA-F0-9]+$/;

export class AuthorizationTupleDto {
  @IsInt()
  chainId!: number;

  @IsString()
  @Matches(HEX)
  address!: string;

  @IsString()
  nonce!: string;

  @IsString()
  @Matches(HEX)
  signature!: string;
}

export class SubmitTransactionRequestDto {
  @IsString()
  @Matches(HEX)
  signature!: string;

  @ValidateNested()
  @Type(() => AuthorizationTupleDto)
  authorization!: AuthorizationTupleDto;
}

export class SubmitTransactionResponseDto {
  requestId!: string;
  status!: string;
}

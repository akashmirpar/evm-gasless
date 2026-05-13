import { IsInt, IsString, Matches } from 'class-validator';

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

  authorization!: AuthorizationTupleDto;
}

export class SubmitTransactionResponseDto {
  requestId!: string;
  status!: string;
}

import { Type } from 'class-transformer';
import { IsArray, IsInt, ValidateNested } from 'class-validator';

import { AddressField } from '../../../common/address/address_field.decorator';
import { UserOpDto } from './estimate.dto';

export class CreateTransactionRequestDto {
  @IsInt()
  chainId!: number;

  @AddressField('chainId')
  userAddress!: string;

  @AddressField('chainId')
  feeTokenAddress!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserOpDto)
  operations!: UserOpDto[];
}

export class PreparedOpDto {
  to!: string;
  value!: string;
  data!: string;
}

export class CreateTransactionResponseDto {
  requestId!: string;
  delegateContractAddress!: string;
  chainId!: number;
  nonce!: string;
  atomicGroupStart!: number;
  operations!: PreparedOpDto[];
  digest!: string;
  expiresAtSeconds!: number;
}

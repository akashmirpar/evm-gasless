import { Type } from 'class-transformer';
import { IsArray, IsInt, IsString, Matches, ValidateNested } from 'class-validator';

import { AddressField } from '../../../common/address/address_field.decorator';
import { INTEGER_AMOUNT_REGEX } from '../../../common/utils/amount.regex';

export class UserOpDto {
  @IsInt()
  chainId!: number;

  @AddressField('chainId')
  to!: string;

  @IsString()
  @Matches(INTEGER_AMOUNT_REGEX, { message: 'value must be a non-negative integer string (wei)' })
  value!: string;

  @IsString()
  @Matches(/^0x[a-fA-F0-9]*$/)
  data!: string;
}

export class EstimateRequestDto {
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

export class EstimateResponseDto {
  feeTokenAddress!: string;
  feeAmount!: string;
  acceptedFeeToken!: boolean;
  swapRoute?: {
    inputToken: string;
    outputToken: string;
    outputAmount: string;
  };
}

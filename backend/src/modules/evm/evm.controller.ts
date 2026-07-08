import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { CtxParam } from '../../core/context/ctx.decorator';
import { RequestContext } from '../../core/context/context';
import { CreateTransactionRequestDto, CreateTransactionResponseDto } from './dto/create_transaction.dto';
import { EstimateRequestDto, EstimateResponseDto } from './dto/estimate.dto';
import { StatusResponseDto } from '../../common/dto/status.dto';
import { SubmitTransactionRequestDto, SubmitTransactionResponseDto } from './dto/submit.dto';
import { EvmService } from './services/evm.service';

@Controller('gasless/transactions')
export class EvmController {
  constructor(private readonly gasless: EvmService) {}

  @Post('estimate')
  estimate(@Body() body: EstimateRequestDto): Promise<EstimateResponseDto> {
    return this.gasless.estimate(body);
  }

  @Post()
  create(@Body() body: CreateTransactionRequestDto): Promise<CreateTransactionResponseDto> {
    return this.gasless.createTransaction(body);
  }

  @Post(':requestId/submit')
  submit(
    @CtxParam() ctx: RequestContext,
    @Param('requestId') requestId: string,
    @Body() body: SubmitTransactionRequestDto,
  ): Promise<SubmitTransactionResponseDto> {
    return this.gasless.submit(ctx, requestId, body);
  }

  @Get(':requestId')
  status(@CtxParam() ctx: RequestContext, @Param('requestId') requestId: string): Promise<StatusResponseDto> {
    return this.gasless.status(ctx, requestId);
  }
}

import { Global, Module } from '@nestjs/common';

import { TokenMetadataService } from './token_metadata.service';

@Global()
@Module({
  providers: [TokenMetadataService],
  exports: [TokenMetadataService],
})
export class TokenMetadataModule {}

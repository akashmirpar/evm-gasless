import { Global, Module } from '@nestjs/common';

import { RangoClient } from './rango.client';
import { RangoHttpClient } from './rango_http.client';

@Global()
@Module({
  providers: [{ provide: RangoClient, useClass: RangoHttpClient }],
  exports: [RangoClient],
})
export class RangoModule {}

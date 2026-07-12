import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { AdminEntity } from './domain/entity/admin.entity';
import { AdminAuditEntity } from './domain/entity/admin_audit.entity';
import { ApiKeyAuditEntity } from './domain/entity/api_key_audit.entity';
import { AdminController } from './interface/controllers/admin.controller';
import { AdminApiKeyController } from './interface/controllers/api_key.controller';
import { AdminKeyGuard } from './interface/guards/admin_key.guard';
import { AdminApiKeyService } from './services/admin_api_key.service';
import { AdminAuthService } from './services/admin_auth.service';
import { AdminService } from './services/admin.service';

@Module({
  imports: [TypeOrmModule.forFeature([AdminEntity, AdminAuditEntity, ApiKeyAuditEntity]), AuthModule],
  controllers: [AdminController, AdminApiKeyController],
  providers: [AdminAuthService, AdminService, AdminApiKeyService, AdminKeyGuard],
  exports: [AdminAuthService, AdminService, AdminApiKeyService, AdminKeyGuard],
})
export class AdminModule {}

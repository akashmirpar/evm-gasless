import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { Admin } from '../decorators';
import { AdminKeyGuard } from '../guards/admin_key.guard';
import { AdminApiKeyService } from '../../services/admin_api_key.service';
import { ApiKeyEntity } from '../../../auth/domain/entity/api_key.entity';
import type { AdminEntity } from '../../domain/entity/admin.entity';
import {
  ApiKeyResponseDto,
  CreateApiKeyRequestDto,
  SetActiveRequestDto,
  UpdateApiKeyRequestDto,
} from '../../domain/dto/api_key.dto';
import { buildContext } from './request_context';

@Controller('admin/api-keys')
@UseGuards(AdminKeyGuard)
export class AdminApiKeyController {
  constructor(private readonly service: AdminApiKeyService) {}

  @Get()
  async list(): Promise<ApiKeyResponseDto[]> {
    const rows = await this.service.list();
    return rows.map(toResponse);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Admin() admin: AdminEntity,
    @Req() request: Request,
    @Body() body: CreateApiKeyRequestDto,
  ): Promise<ApiKeyResponseDto> {
    const saved = await this.service.create(body, buildContext(admin.id, request));
    return toResponse(saved);
  }

  @Patch(':id')
  async update(
    @Admin() admin: AdminEntity,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateApiKeyRequestDto,
  ): Promise<ApiKeyResponseDto> {
    const saved = await this.service.update(id, body, buildContext(admin.id, request));
    return toResponse(saved);
  }

  @Patch(':id/active')
  async setActive(
    @Admin() admin: AdminEntity,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetActiveRequestDto,
  ): Promise<ApiKeyResponseDto> {
    const saved = await this.service.setActive(id, body.isActive, buildContext(admin.id, request, body.reason));
    return toResponse(saved);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Admin() admin: AdminEntity,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.delete(id, buildContext(admin.id, request));
  }
}

function toResponse(row: ApiKeyEntity): ApiKeyResponseDto {
  return {
    id: row.id,
    clientName: row.clientName,
    key: row.key,
    rateLimitRps: row.rateLimitRps,
    whiteList: row.whiteList,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

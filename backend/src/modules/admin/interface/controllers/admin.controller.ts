import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { Admin } from '../decorators';
import { AdminKeyGuard } from '../guards/admin_key.guard';
import { AdminService } from '../../services/admin.service';
import { AdminEntity } from '../../domain/entity/admin.entity';
import {
  AdminCreatedResponseDto,
  AdminKeyRotatedResponseDto,
  AdminResponseDto,
  CreateAdminRequestDto,
  RotateAdminKeyRequestDto,
  SetAdminActiveRequestDto,
} from '../../domain/dto/admin.dto';
import { buildContext } from './request_context';

@Controller('admin/admins')
@UseGuards(AdminKeyGuard)
export class AdminController {
  constructor(private readonly service: AdminService) {}

  @Get()
  async list(): Promise<AdminResponseDto[]> {
    const rows = await this.service.list();
    return rows.map(toResponse);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Admin() actor: AdminEntity,
    @Req() request: Request,
    @Body() body: CreateAdminRequestDto,
  ): Promise<AdminCreatedResponseDto> {
    const { admin, plaintextKey } = await this.service.create({ name: body.name }, buildContext(actor.id, request));
    return { ...toResponse(admin), plaintextKey };
  }

  @Post(':id/rotate-key')
  async rotateKey(
    @Admin() actor: AdminEntity,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RotateAdminKeyRequestDto,
  ): Promise<AdminKeyRotatedResponseDto> {
    const { admin, plaintextKey } = await this.service.rotateKey(id, buildContext(actor.id, request, body.reason));
    return { id: admin.id, plaintextKey };
  }

  @Patch(':id/active')
  async setActive(
    @Admin() actor: AdminEntity,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetAdminActiveRequestDto,
  ): Promise<AdminResponseDto> {
    const saved = await this.service.setActive(id, body.isActive, buildContext(actor.id, request, body.reason));
    return toResponse(saved);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Admin() actor: AdminEntity,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.delete(id, buildContext(actor.id, request));
  }
}

function toResponse(row: AdminEntity): AdminResponseDto {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

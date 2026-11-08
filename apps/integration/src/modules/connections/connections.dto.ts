import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { MarketplaceProvider } from '../../domain/integration-domain';

export class CreateChannelConnectionDto {
  @IsIn(['SHOPEE', 'LAZADA'])
  provider!: MarketplaceProvider;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalShopId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  shopName?: string;

  @IsUUID()
  branchId!: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  safetyStockBuffer?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  stockAllocationPercent?: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  webhookSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  partnerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  accessToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}

export class AuthorizeChannelConnectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  redirectUri?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  authorizationCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  stateNonce?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalShopId?: string;
}

export class RefreshConnectionTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  workerId?: string;
}

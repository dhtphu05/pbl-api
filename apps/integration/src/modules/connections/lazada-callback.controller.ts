import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@pbl/auth';
import { TenantContext } from '@pbl/common';
import type { Response } from 'express';
import { ConnectionsService } from './connections.service';
import { validateSignedOAuthState } from './lazada-oauth-state';

/**
 * Lazada sends a browser GET without the Platform JWT. The signed state is
 * the only bridge from a public callback to the authenticated tenant that
 * initiated authorization. Do not accept tenantId or a return URL from query.
 */
@ApiTags('integration-lazada-oauth')
@Controller('api/v1/integrations/lazada')
export class LazadaCallbackController {
  constructor(private readonly connections: ConnectionsService) {}

  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'Lazada seller OAuth callback (public, state-verified)' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error || !code || !state || code.length > 2048) {
      res.status(400).type('text/plain').send('Lazada authorization was not completed.');
      return;
    }
    try {
      const claims = validateSignedOAuthState(state);
      await TenantContext.run(claims.tenantId, () =>
        this.connections.authorizeConnection(claims.connectionId, claims.actorId, {
          authorizationCode: code,
          stateNonce: state,
        }),
      );
      const redirectUrl = process.env.LAZADA_POST_AUTH_REDIRECT_URL;
      if (redirectUrl) {
        res.redirect(303, redirectUrl);
      } else {
        res.status(200).type('text/plain').send('Lazada shop connected. You may return to SapoClone.');
      }
    } catch {
      // Never echo provider codes, tokens, secrets or raw error messages to a public callback.
      res.status(400).type('text/plain').send('Lazada authorization failed. Restart connection from SapoClone.');
    }
  }
}

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from "@nestjs/common";
import {
  type AiModelChoicesInput,
  type AiProviderKeyInput,
  type AiProviderParams,
  aiModelChoicesSchema,
  aiProviderKeySchema,
  aiProviderParamsSchema,
} from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import { AiKeyStore } from "@symplist/core/ai";
import { SimonRepository } from "@symplist/core/simon";
import { Access, CurrentSession } from "../../common/access.decorator.ts";
import { RouteClass } from "../../common/route-classes.ts";
import { API_CONFIG, type ApiConfig } from "../../infra/config/api-config.ts";

/**
 * Each account's model keys and tier choices (§8.6).
 *
 * The shape of this controller is the whole security argument: a key can be written and deleted,
 * and there is no route that reads one back. `GET` returns whether a provider is configured and
 * when, never the value, so a compromised session cannot exfiltrate a key that was set on another
 * device — and neither can a bug here, because the response type has nowhere to put one.
 *
 * Writing a key is `fresh`, like the other settings that change what an account can spend. It is
 * deliberately not idempotent-folded: a folded route stores its request and response so an exact
 * retry can replay them, and the request here is the key itself.
 */
@Controller("ai")
@RouteClass("app")
@Access("admitted")
export class AiSettingsController {
  private readonly keys: AiKeyStore;

  constructor(
    @Inject(SimonRepository) repository: SimonRepository,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.keys = new AiKeyStore({
      ...repository.options,
      defaults: {
        fast: { provider: config.AI_FAST_PROVIDER, model: config.AI_FAST_MODEL },
        smart: { provider: config.AI_SMART_PROVIDER, model: config.AI_SMART_MODEL },
      },
      now: () => Date.now(),
    });
  }

  /** What is configured and what each tier will run. Never a key. */
  @Get()
  settings(@CurrentSession() session: SessionContext) {
    return this.keys.settings(session.userId);
  }

  @Put("keys/:provider")
  @HttpCode(204)
  @Access("admitted", { fresh: true })
  async setKey(
    @CurrentSession() session: SessionContext,
    @Param({ schema: aiProviderParamsSchema }) params: AiProviderParams,
    @Body({ schema: aiProviderKeySchema }) body: AiProviderKeyInput,
  ): Promise<void> {
    await this.keys.setKey(session.userId, params.provider, body.key);
  }

  @Delete("keys/:provider")
  @HttpCode(204)
  @Access("admitted", { fresh: true })
  async clearKey(
    @CurrentSession() session: SessionContext,
    @Param({ schema: aiProviderParamsSchema }) params: AiProviderParams,
  ): Promise<void> {
    await this.keys.clearKey(session.userId, params.provider);
  }

  /** Chooses what answers each tier. Returns the settings so the screen never guesses the result. */
  @Put("models")
  async setModels(
    @CurrentSession() session: SessionContext,
    @Body({ schema: aiModelChoicesSchema }) body: AiModelChoicesInput,
  ) {
    await this.keys.setChoices(session.userId, body);
    return await this.keys.settings(session.userId);
  }
}

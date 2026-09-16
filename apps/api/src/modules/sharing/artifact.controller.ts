import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { idSchema, sharingPasswordRequestSchema } from "@symplist/contracts";
import { type ShareReadInput, SharingError, SharingReader } from "@symplist/core/sharing";
import type { Request, Response } from "express";
import type { z } from "zod";
import { RouteClass } from "../../common/route-classes.ts";
import { artifactHeaders, artifactPage, artifactUnavailable } from "./artifact-renderer.ts";

@Controller("artifact")
export class ArtifactController {
  constructor(@Inject(SharingReader) private readonly reader: SharingReader) {}

  @Get(":id")
  @RouteClass("share_read")
  html(
    @Param("id", { schema: idSchema }) artifactId: string,
    @Query("key") key: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.render(
      { artifactId, ...(typeof key === "string" ? { key } : {}), cookies: req.cookies },
      res,
      false,
    );
  }
  @Get(":id/raw")
  @RouteClass("share_read")
  raw(
    @Param("id", { schema: idSchema }) artifactId: string,
    @Query("key") key: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.render(
      { artifactId, ...(typeof key === "string" ? { key } : {}), cookies: req.cookies },
      res,
      true,
    );
  }
  @Get(":id/public/:publicationId")
  @RouteClass("share_read")
  publicHtml(
    @Param("id", { schema: idSchema }) artifactId: string,
    @Param("publicationId", { schema: idSchema }) publicationId: string,
    @Res() res: Response,
  ) {
    return this.render({ artifactId, publicationId }, res, false);
  }
  @Get(":id/public/:publicationId/raw")
  @RouteClass("share_read")
  publicRaw(
    @Param("id", { schema: idSchema }) artifactId: string,
    @Param("publicationId", { schema: idSchema }) publicationId: string,
    @Res() res: Response,
  ) {
    return this.render({ artifactId, publicationId }, res, true);
  }
  @Post(":id/password")
  @RouteClass("share_form")
  async password(
    @Param("id", { schema: idSchema }) artifactId: string,
    @Body({ schema: sharingPasswordRequestSchema }) body: z.infer<
      typeof sharingPasswordRequestSchema
    >,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.set(artifactHeaders);
    try {
      const session = await this.reader.password({ artifactId, ...body, ip: req.ip ?? "unknown" });
      res.cookie(session.cookieName, session.token, {
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: session.maxAgeSeconds * 1000,
      });
      res.redirect(303, `/artifact/${artifactId}?key=${encodeURIComponent(body.key)}`);
    } catch (error) {
      if (error instanceof SharingError && error.code === "sharing.password_invalid")
        return this.render({ artifactId, key: body.key }, res, false, true);
      res
        .status(error instanceof SharingError && error.code === "rate.limited" ? 429 : 404)
        .type("html")
        .send(artifactUnavailable(error instanceof SharingError && error.code === "rate.limited"));
    }
  }
  private async render(
    input: ShareReadInput,
    res: Response,
    raw: boolean,
    invalidPassword = false,
  ) {
    res.set(artifactHeaders);
    try {
      const result = await this.reader.read(input);
      if (raw && result.kind === "content") {
        res.set("Content-Security-Policy", "sandbox; default-src 'none'");
        res.type("text/markdown; charset=utf-8").send(result.markdown);
      } else if (raw) res.status(403).type("html").send(artifactUnavailable());
      else
        res
          .status(invalidPassword ? 403 : 200)
          .type("html")
          .send(artifactPage(result, { ...input, invalidPassword }));
    } catch {
      res.status(404).type("html").send(artifactUnavailable());
    }
  }
}

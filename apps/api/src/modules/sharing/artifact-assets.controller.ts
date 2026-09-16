import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { RouteClass } from "../../common/route-classes.ts";
import { artifactHeaders, artifactUnavailable } from "./artifact-renderer.ts";

const require = createRequire(import.meta.url);
const fontFiles: Readonly<Record<string, string>> = Object.fromEntries(
  ["latin", "latin-ext", "vietnamese"].flatMap((subset) =>
    ["normal", "italic"].map((style) => {
      const name = `geist-${subset}-wght-${style}.woff2`;
      return [name, require.resolve(`@fontsource-variable/geist/files/${name}`)];
    }),
  ),
);
/** Fixed allowlist: request input can never become a filesystem path. */
@Controller("artifact/_assets")
@RouteClass("share_read")
export class ArtifactAssetsController {
  @Get(":name")
  async get(@Param("name") name: string, @Res() res: Response) {
    res.set(artifactHeaders);
    const file = Object.hasOwn(fontFiles, name) ? fontFiles[name] : undefined;
    if (!file) return res.status(404).type("html").send(artifactUnavailable());
    return res.type("font/woff2").send(await readFile(file));
  }
}

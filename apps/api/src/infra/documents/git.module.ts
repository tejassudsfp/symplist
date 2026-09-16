import { Global, Module } from "@nestjs/common";
import { GitService } from "@symplist/docs";
import { API_CONFIG, type ApiConfig } from "../config/api-config.ts";

/** One process-wide two-slot Git service for user, MCP and local Simon work (§9.1). */
export const DOCUMENT_GIT = "symplist:DOCUMENT_GIT";

@Global()
@Module({
  providers: [
    {
      provide: DOCUMENT_GIT,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        new GitService({
          tempDir: config.GIT_TMP_DIR,
          limits: { maxConcurrent: 2, maxQueued: 16, maxBlobBytes: config.DOC_MAX_BYTES },
        }),
    },
  ],
  exports: [DOCUMENT_GIT],
})
export class DocumentGitRuntimeModule {}
